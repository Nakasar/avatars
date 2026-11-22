import type { Voice } from '../avatar/Voice';
import type { BreignService } from '../breign/BreignService';
import { describeError } from '../breign/BreignService';
import type { Conversation } from './Conversation';
import { VoiceActivity, type Utterance } from './VoiceActivity';

export interface TranscriptLine {
  /** Heure locale, ex. « 14:03:22 ». */
  time: string;
  text: string;
  /** Le mot d'activation y était présent : l'avatar a été appelé. */
  addressed: boolean;
  /** C'est la voix de l'avatar lui-même (retour micro) : affiché à part, jamais déclencheur. */
  self?: boolean;
}

/** Source audio du mode réunion : onglet de visioconférence, ou micro de l'appareil (pièce). */
export type MeetingSource = 'tab' | 'mic';

export interface MeetingEvents {
  /** Nouvelle ligne de transcription (complète, horodatée). */
  onTranscript?: (line: TranscriptLine) => void;
  /** Le mode réunion démarre (`true`) ou s'arrête (`false`), avec sa source. */
  onActive?: (active: boolean, source?: MeetingSource) => void;
  onError?: (message: string) => void;
  /** Niveau sonore de la réunion, 0–1, pour l'indicateur visuel. */
  onLevel?: (level: number) => void;
}

/** VAD du mode réunion : pauses plus longues entre les tours, énoncés potentiellement longs. */
const MEETING_VAD = {
  startMs: 200,
  endSilenceMs: 1200,
  preRollMs: 400,
  minSpeechMs: 350,
  maxUtteranceMs: 60_000,
  thresholdDb: 12,
  floorDb: -58,
  bargeInBoostDb: 9,
  bargeInStartMs: 320,
};

/** Nombre de lignes de transcription gardées (affichage et contexte envoyé à l'agent). */
const MAX_LINES = 200;
/** Lignes récentes transmises à l'agent quand on l'appelle, pour le contexte de la réunion. */
const CONTEXT_LINES = 12;

/**
 * Mode réunion : l'avatar devient un participant actif. Il écoute la réunion — l'audio d'un
 * onglet de visioconférence (`getDisplayMedia`) ou le micro de l'appareil posé dans la pièce —
 * le découpe en énoncés (VAD), transcrit chaque énoncé (STT Breign) dans un panneau, et quand
 * le mot d'activation est prononcé (« Breign, … »), il interrompt ce qu'il fait, envoie la
 * question à l'agent (avec les dernières lignes de la transcription en contexte) et répond de
 * vive voix. En mode « mic », sa propre voix (retour des enceintes) est reconnue et ignorée.
 *
 * Pendant que l'avatar parle, les seuils du VAD sont relevés (barge-in) : si quelqu'un de la
 * réunion reprend la parole, l'avatar se tait aussitôt.
 */
export class MeetingSession {
  private vad?: VoiceActivity;
  private stream?: MediaStream;
  private ownsStream = false;
  private source?: MeetingSource;
  private turn = 0;
  private lines: TranscriptLine[] = [];
  /** Ce que l'avatar vient de dire (pour reconnaître sa propre voix revenue par le micro). */
  private agentSpeech = '';

  constructor(
    private voice: Voice,
    private conversation: Conversation,
    private getBreign: () => BreignService,
    /** Mot d'activation résolu (réglage, sinon nom de l'agent, sinon « breign »). */
    private getWakeWord: () => string,
    private events: MeetingEvents = {},
  ) {
    // Chaîne le gestionnaire de la Conversation (construite avant) : quand l'avatar parle, le
    // VAD de la réunion relève aussi ses seuils d'interruption (barge-in).
    const previous = voice.onSpeakingChange;
    voice.onSpeakingChange = (speaking) => {
      if (this.vad) this.vad.avatarSpeaking = speaking;
      previous?.(speaking);
    };
  }

  get active() {
    return Boolean(this.stream);
  }

  /** Source du mode réunion en cours (`tab` ou `mic`). */
  get currentSource() {
    return this.source;
  }

  /**
   * Démarre le mode réunion.
   * - `tab` : demande à l'utilisateur de partager un onglet de visioconférence (geste requis
   *   par `getDisplayMedia`) et écoute son audio ; la piste vidéo est coupée aussitôt.
   * - `mic` : écoute le micro de l'appareil (PC ou téléphone posé dans la pièce). Avec
   *   `micStream`, réutilise le micro déjà ouvert de la conversation (pas de double capture) ;
   *   sinon ouvre son propre micro.
   */
  async start(source: MeetingSource = 'tab', micStream?: MediaStream) {
    if (this.stream) return;
    this.source = source;
    let stream: MediaStream;
    let owns = false;
    if (source === 'mic') {
      if (micStream) {
        stream = micStream;
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          });
        } catch {
          this.source = undefined;
          this.events.onError?.('Micro indisponible : autorisez-le pour que l’avatar écoute la pièce.');
          return;
        }
        owns = true;
      }
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        this.source = undefined;
        this.events.onError?.('La capture d’onglet (getDisplayMedia) n’est pas disponible dans ce navigateur.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          // Chrome n'accorde l'audio d'un onglet que si la vidéo est demandée : on la coupe après.
          video: { displaySurface: 'browser' } as MediaTrackConstraints,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
      } catch {
        this.source = undefined;
        return; // partage annulé par l'utilisateur
      }
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((t) => t.stop());
        this.source = undefined;
        this.events.onError?.(
          'Aucun son capturé : partagez un onglet en cochant « Partager l’audio de l’onglet », ou l’écran entier avec le son du système.',
        );
        return;
      }
      stream.getVideoTracks().forEach((t) => t.stop());
      // Arrêt du partage depuis la barre du navigateur (« Arrêter le partage »).
      audioTracks[0].addEventListener('ended', () => this.stop());
    }
    this.stream = stream;
    this.ownsStream = owns;

    const vad = (this.vad = new VoiceActivity(this.voice.ctx, MEETING_VAD));
    vad.onSpeechStart = (bargeIn) => this.conversation.noteSpeechStart(bargeIn);
    vad.onSpeechEnd = (u) => void this.onUtterance(u);
    vad.onLevel = (level) => this.events.onLevel?.(level);
    try {
      await vad.start(stream);
    } catch (e) {
      this.stop();
      this.events.onError?.(`Audio de la réunion illisible : ${e instanceof Error ? e.message : e}`);
      return;
    }
    this.events.onActive?.(true, source);
  }

  stop() {
    const vad = this.vad;
    const source = this.source;
    this.vad = undefined;
    this.source = undefined;
    this.turn++;
    vad?.stop(); // le VAD n'est jamais propriétaire du flux
    if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.ownsStream = false;
    if (vad) this.events.onActive?.(false, source);
  }

  /** Mémorise le texte que l'avatar vient de prononcer (filtre anti-écho en mode « mic »). */
  noteAgentText(text: string) {
    this.agentSpeech = text.slice(-400);
  }

  private isEcho(text: string) {
    return isEchoOf(text, this.agentSpeech);
  }

  /** Transcrit un énoncé de la réunion ; appelle l'avatar si le mot d'activation est présent. */
  private async onUtterance(u: Utterance) {
    const turn = ++this.turn;
    const breign = this.getBreign();
    if (!breign.configured) {
      this.conversation.noteSpeechEnd();
      return;
    }
    let text: string;
    try {
      text = await this.conversation.transcribe(u);
    } catch (e) {
      if (turn === this.turn) this.events.onError?.(await describeError(e));
      this.conversation.noteSpeechEnd();
      return;
    }
    if (turn !== this.turn || !text) {
      if (turn === this.turn) this.conversation.noteSpeechEnd();
      return;
    }
    // En mode « mic », l'appareil peut entendre sa propre voix (enceintes) : on la reconnaît
    // au chevauchement de mots avec ce que l'avatar vient de dire, et elle ne déclenche rien.
    const self = this.isEcho(text);
    const hit = self ? null : findWakeWord(text, this.getWakeWord());
    const line: TranscriptLine = { time: timestamp(), text, addressed: Boolean(hit), self };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    this.events.onTranscript?.(line);
    if (self || !hit) {
      this.conversation.noteSpeechEnd();
      return;
    }
    // La question est ce qui suit le mot d'activation (« Breign, quelles sont les étapes ? »).
    const question = (text.slice(hit.index + hit.length).trim() || text.slice(0, hit.index).trim() || text).trim();
    const context = this.lines.slice(-CONTEXT_LINES).map((l) => `${l.time} — ${l.text}`).join('\n');
    const en = breign.settings.lang.startsWith('en');
    const message = en
      ? `[Meeting transcript — last lines]\n${context}\n\n[You are being addressed in the meeting]: “${question}”`
      : `[Transcription de la réunion — dernières lignes]\n${context}\n\n[On s’adresse à toi dans la réunion] : « ${question} »`;
    this.conversation.sendText(message);
  }
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Vrai si `text` ressemble à ce que l'avatar vient de dire (≥ 70 % de mots communs, 4 mots
 * minimum) : c'est probablement sa propre voix revenue par le micro de la pièce.
 */
export function isEchoOf(text: string, agentSpeech: string): boolean {
  const words = normalizeForMatch(text).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length < 4 || !agentSpeech) return false;
  const spoken = new Set(normalizeForMatch(agentSpeech).split(/[^a-z0-9]+/));
  const hits = words.filter((w) => spoken.has(w)).length;
  return hits / words.length >= 0.7;
}

/**
 * Normalise pour la comparaison (minuscules, accents aplatis) en conservant la longueur :
 * chaque caractère d'origine produit exactement un caractère, donc les index trouvés dans le
 * texte normalisé sont aussi valables dans le texte d'origine.
 */
export function normalizeForMatch(s: string): string {
  return [...s].map((c) => c.normalize('NFD')[0]).join('').toLowerCase();
}

/**
 * Cherche le mot d'activation dans `text` (frontières de mot, insensible à la casse et aux
 * accents). Renvoie sa position dans le texte d'origine, ou `null`.
 */
export function findWakeWord(text: string, wake: string): { index: number; length: number } | null {
  const w = normalizeForMatch(wake).replace(/\s+/g, ' ').trim();
  if (!w) return null;
  const pattern = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const m = new RegExp(`(^|[^a-z0-9])${pattern}(?![a-z0-9])`).exec(normalizeForMatch(text));
  if (!m) return null;
  return { index: m.index + m[1].length, length: m[0].length - m[1].length };
}
