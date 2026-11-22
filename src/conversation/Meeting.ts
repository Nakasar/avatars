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
}

export interface MeetingEvents {
  /** Nouvelle ligne de transcription (complète, horodatée). */
  onTranscript?: (line: TranscriptLine) => void;
  /** Le mode réunion démarre (`true`) ou s'arrête (`false`). */
  onActive?: (active: boolean) => void;
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
 * Mode réunion : l'avatar devient un participant actif. Il capture l'audio d'un onglet de
 * visioconférence (`getDisplayMedia`), le découpe en énoncés (VAD), transcrit chaque énoncé
 * (STT Breign) dans un panneau, et quand le mot d'activation est prononcé (« Breign, … »),
 * il interrompt ce qu'il fait, envoie la question à l'agent (avec les dernières lignes de la
 * transcription en contexte) et répond de vive voix.
 *
 * Pendant que l'avatar parle, les seuils du VAD sont relevés (barge-in) : si quelqu'un de la
 * réunion reprend la parole, l'avatar se tait aussitôt.
 */
export class MeetingSession {
  private vad?: VoiceActivity;
  private stream?: MediaStream;
  private turn = 0;
  private lines: TranscriptLine[] = [];

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

  /**
   * Demande à l'utilisateur de partager un onglet (ou l'écran) et écoute son audio.
   * À appeler depuis un geste utilisateur (`getDisplayMedia` l'exige).
   */
  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.events.onError?.('La capture d’onglet (getDisplayMedia) n’est pas disponible dans ce navigateur.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // Chrome n'accorde l'audio d'un onglet que si la vidéo est demandée : on la coupe après.
        video: { displaySurface: 'browser' } as MediaTrackConstraints,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } catch {
      return; // partage annulé par l'utilisateur
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      this.events.onError?.(
        'Aucun son capturé : partagez un onglet en cochant « Partager l’audio de l’onglet », ou l’écran entier avec le son du système.',
      );
      return;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    this.stream = stream;
    // Arrêt du partage depuis la barre du navigateur (« Arrêter le partage »).
    audioTracks[0].addEventListener('ended', () => this.stop());

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
    this.events.onActive?.(true);
  }

  stop() {
    const vad = this.vad;
    this.vad = undefined;
    this.turn++;
    vad?.stop(); // stream externe : les pistes ne sont pas arrêtées ici
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    if (vad) this.events.onActive?.(false);
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
    const hit = findWakeWord(text, this.getWakeWord());
    const line: TranscriptLine = { time: timestamp(), text, addressed: Boolean(hit) };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    this.events.onTranscript?.(line);
    if (!hit) {
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
