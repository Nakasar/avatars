import type { MeetingSegmentUio, MeetingUio, TranscriptionSessionUio } from '@breign/client';
import type { Voice } from '../avatar/Voice';
import type { BreignService } from '../breign/BreignService';
import { describeError } from '../breign/BreignService';
import { TranscriptionStream, type TranscriptFrame } from '../breign/TranscriptionStream';
import { encodeWav } from './VoiceActivity';
import type { Conversation } from './Conversation';
import { VoiceActivity } from './VoiceActivity';

/** Ligne affichée dans le panneau de la réunion. */
export interface MeetingLine {
  /** Numéro du segment côté Breign. */
  seq: number;
  /** Heure locale, ex. « 14:03:22 ». */
  time: string;
  text: string;
  /** Locuteur, quand le modèle de transcription le donne. */
  speaker?: string | null;
  /** `transcript` : la réunion ; `agent` : la réponse de l'agent. */
  source: 'transcript' | 'agent';
  /** Le segment a réveillé l'agent (mot d'activation, message écrit de l'hôte). */
  addressed: boolean;
  /** Réveillé à tort : l'agent a jugé que ça ne lui était pas adressé. */
  ignored?: boolean;
}

/** Source audio du mode réunion : onglet de visioconférence, ou micro de l'appareil (pièce). */
export type MeetingSource = 'tab' | 'mic';

export interface MeetingEvents {
  /** Nouveaux segments de la transcription (dans l'ordre). */
  onLines?: (lines: MeetingLine[]) => void;
  /** Texte provisoire de la phrase en cours (`null` : plus rien en cours). */
  onLive?: (text: string | null) => void;
  /** Notes, points clés et état de la réunion (à chaque mise à jour, et le compte rendu final). */
  onMeeting?: (meeting: MeetingUio) => void;
  /** Le mode réunion démarre (`true`) ou s'arrête (`false`), avec sa source. */
  onActive?: (active: boolean, source?: MeetingSource) => void;
  onError?: (message: string) => void;
  /** Niveau sonore de la réunion, 0–1, pour l'indicateur visuel. */
  onLevel?: (level: number) => void;
}

/** VAD du mode réunion : il ne découpe plus rien, il mesure le niveau et détecte le barge-in. */
const MEETING_VAD = {
  startMs: 200,
  endSilenceMs: 1200,
  preRollMs: 400,
  minSpeechMs: 350,
  maxUtteranceMs: 60_000,
  thresholdDb: 12,
  floorDb: -58,
  bargeInBoostDb: 9,
  // En réunion, on ne coupe l'avatar que pour une vraie prise de parole, pas pour un « hmm ».
  bargeInStartMs: 900,
};

/** Lecture des nouveaux segments (réponses de l'agent comprises). */
const SEGMENTS_POLL_MS = 1500;
/** Lecture des notes et des points clés. */
const NOTES_POLL_MS = 20_000;
/** Après la fin : attente du compte rendu final (« environ une minute » selon la doc). */
const REPORT_POLL_MS = 15_000;
const REPORT_MAX_MS = 4 * 60_000;
/** Segments déjà présents relus à la reprise d'une réunion. */
const RESUME_LINES = 200;
/**
 * Réponse de l'agent sans voix de Breign (`agent.audio`) au bout de ce délai : synthèse locale
 * avec la voix de l'app configurée ici (agent sans « app qui prête sa voix »).
 */
const SERVER_VOICE_GRACE_MS = 2500;
/** Réunion de cet appareil, reprise après un rechargement de la page. */
const STORAGE_KEY = 'breign-avatar:meeting';

/**
 * Mode réunion, sur l'API « meetings » de Breign. L'avatar écoute la réunion — l'audio d'un
 * onglet de visioconférence (`getDisplayMedia`) ou le micro de l'appareil posé dans la pièce —
 * et le streame en continu vers la session de transcription de la réunion. Tout le reste est
 * fait par Breign : transcription, mots d'activation (nom de l'agent, surnoms, « Breign »,
 * « bot », « agent »), contexte des dernières minutes, réponse de l'agent, notes et points clés
 * (décisions, actions, risques, questions), compte rendu final.
 *
 * L'avatar, lui :
 *  - affiche la transcription en direct (texte provisoire du WebSocket, puis segments) ;
 *  - affiche les réponses de l'agent (segments `agent`) ; quand l'agent a une « app qui prête sa
 *    voix » (`meetingConfiguration.voiceAppId`), Breign les synthétise et les envoie sur le
 *    WebSocket (`agent.audio`) : l'avatar les joue telles quelles, lip-sync sur le son. Sans
 *    elle, il les synthétise avec la voix de l'app réglée ici. Quelqu'un qui prend vraiment la
 *    parole (près d'une seconde) le fait taire ;
 *  - en mode « mic », n'envoie que du silence pendant qu'il parle lui-même (sa voix revenue par
 *    les enceintes n'entre pas dans la transcription), sauf si on lui coupe la parole ;
 *  - reprend la réunion de cet appareil après une coupure ou un rechargement de la page.
 */
export class MeetingSession {
  private vad?: VoiceActivity;
  private stream?: MediaStream;
  private ownsStream = false;
  private source?: MeetingSource;
  private transcription?: TranscriptionStream;
  private meeting?: MeetingUio;
  /** Dernier segment affiché. */
  private lastSeq = 0;
  /** Les réponses de l'agent jusqu'à ce segment sont déjà dites (ou anciennes : jamais dites). */
  private spokenUntil = 0;
  private segmentsTimer?: number;
  private notesTimer?: number;
  private reportTimer?: number;
  private polling = false;
  /** Quelqu'un parle dans la réunion (VAD) : sert au barge-in en mode « mic ». */
  private inSpeech = false;
  /** Incrémenté à l'arrêt : les réponses tardives d'une session close sont ignorées. */
  private epoch = 0;
  /** Breign dit lui-même les réponses (trames `agent.audio` reçues) : pas de synthèse locale. */
  private serverVoice = false;
  /** Réponse dite par la voix de Breign en cours (pour regrouper ses phrases). */
  private audioReply?: string;
  private lastAudioAt = 0;
  /** Dernier morceau `agent.audio` reçu (sans identifiant, regroupe les morceaux rapprochés). */
  private lastChunkAt = 0;

  constructor(
    private voice: Voice,
    private conversation: Conversation,
    private getBreign: () => BreignService,
    /** Dire les réponses de l'agent à voix haute (sinon : texte seulement). */
    private speakReplies: () => boolean,
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

  /** Réunion Breign en cours (ou la dernière terminée, tant que son compte rendu est attendu). */
  get current() {
    return this.meeting;
  }

  /**
   * Démarre (ou reprend) la réunion.
   * - `tab` : demande de partager un onglet de visioconférence (geste requis par
   *   `getDisplayMedia`) et écoute son audio ; la piste vidéo est coupée aussitôt.
   * - `mic` : écoute le micro de l'appareil. Avec `micStream`, réutilise le micro déjà ouvert
   *   de la conversation (pas de double capture) ; sinon ouvre son propre micro.
   */
  async start(source: MeetingSource = 'tab', micStream?: MediaStream) {
    if (this.stream) return;
    const breign = this.getBreign();
    if (!breign.configured) {
      this.events.onError?.('Connectez-vous avec Breign et choisissez un agent (⚙) pour le mode réunion.');
      return;
    }
    const captured = await this.capture(source, micStream);
    if (!captured) return;
    const epoch = ++this.epoch;
    this.source = source;
    this.stream = captured.stream;
    this.ownsStream = captured.owns;

    // 1. Réunion Breign : celle de cet appareil si elle est encore active, sinon une nouvelle.
    let first: TranscriptionSessionUio;
    try {
      const opened = await this.openMeeting(breign);
      if (epoch !== this.epoch) return;
      this.meeting = opened.meeting;
      first = opened.session;
      this.lastSeq = 0;
      this.serverVoice = false;
      this.audioReply = undefined;
      this.spokenUntil = opened.meeting.lastSegmentSeq ?? 0;
      remember(opened.meeting.id);
    } catch (e) {
      const message = await describeError(e);
      this.release();
      this.events.onError?.(`Réunion impossible à démarrer : ${message}`);
      return;
    }
    const meetingId = this.meeting.id;

    // 2. Transcription en flux : la première session vient de la création, les suivantes
    //    (coupure réseau, session expirée) sont rouvertes sur la réunion.
    const transcription = (this.transcription = new TranscriptionStream({
      basePath: breign.settings.basePath,
      open: async (attempt) => (attempt === 0 ? first : (await breign.resumeMeeting(meetingId)).session),
      onPartial: (_, text) => this.events.onLive?.(text || null),
      onFinal: () => {
        this.events.onLive?.(null);
        void this.pollSegments(); // le segment est enregistré : on l'affiche sans attendre
      },
      onFrame: (f) => this.onFrame(f),
      onState: (st, detail) => {
        if (transcription !== this.transcription) return;
        if (st === 'failed') {
          this.events.onError?.(detail ?? 'Transcription de la réunion interrompue.');
          this.pause();
        }
      },
    }));

    // 3. Audio : le VAD mesure le niveau, détecte le barge-in et cadence l'envoi.
    const vad = (this.vad = new VoiceActivity(this.voice.ctx, MEETING_VAD));
    vad.avatarSpeaking = this.voice.speaking;
    vad.onSpeechStart = (bargeIn) => {
      this.inSpeech = true;
      // Quelqu'un prend vraiment la parole pendant que l'avatar parle : il se tait.
      if (bargeIn) this.conversation.interrupt();
    };
    vad.onSpeechEnd = () => (this.inSpeech = false);
    vad.onSpeechCancel = () => (this.inSpeech = false);
    vad.onLevel = (level) => this.events.onLevel?.(level);
    vad.onFrame = (f, rate) => {
      // Micro de la pièce : pendant que l'avatar parle, sa propre voix ne doit pas être
      // transcrite. On envoie du silence (la session reste vivante), sauf barge-in.
      if (this.source === 'mic' && this.voice.speaking && !this.inSpeech) transcription.pushSilence(20, rate);
      else transcription.pushAudio(f, rate);
    };
    try {
      await vad.start(this.stream);
      await transcription.connect();
    } catch (e) {
      const message = e instanceof Error ? e.message : await describeError(e);
      this.pause();
      this.events.onError?.(`Audio de la réunion illisible : ${message}`);
      return;
    }
    if (epoch !== this.epoch) return;
    this.events.onActive?.(true, source);
    this.events.onMeeting?.(this.meeting);

    // 4. Transcription déjà enregistrée (reprise), puis lecture régulière.
    await this.loadHistory(meetingId);
    this.segmentsTimer = window.setInterval(() => void this.pollSegments(), SEGMENTS_POLL_MS);
    this.notesTimer = window.setInterval(() => void this.refreshMeeting(), NOTES_POLL_MS);
  }

  /**
   * Arrête d'écouter **sans** terminer la réunion (rechargement de la page, partage coupé,
   * erreur) : un nouveau 🎧/🎙️ la reprend. Sans audio pendant 15 min, Breign la termine.
   */
  pause() {
    const vad = this.vad;
    const source = this.source;
    this.epoch++;
    clearInterval(this.segmentsTimer);
    clearInterval(this.notesTimer);
    this.transcription?.stop();
    this.transcription = undefined;
    this.vad = undefined;
    this.source = undefined;
    this.inSpeech = false;
    vad?.stop(); // le VAD n'est jamais propriétaire du flux
    this.release();
    this.events.onLive?.(null);
    if (vad) this.events.onActive?.(false, source);
  }

  /** Termine la réunion : l'agent rédige le compte rendu final, affiché dès qu'il est prêt. */
  async end() {
    const meeting = this.meeting;
    this.pause();
    if (!meeting) return;
    forget(meeting.id);
    const breign = this.getBreign();
    try {
      const ended = await breign.endMeeting(meeting.id);
      this.meeting = ended;
      this.events.onMeeting?.(ended);
    } catch (e) {
      this.events.onError?.(`Fin de réunion : ${await describeError(e)}`);
      return;
    }
    // Compte rendu final : il remplace les notes environ une minute après la fin.
    const version = this.meeting?.notes?.version ?? 0;
    const started = Date.now();
    const epoch = this.epoch;
    clearInterval(this.reportTimer);
    this.reportTimer = window.setInterval(async () => {
      if (epoch !== this.epoch || Date.now() - started > REPORT_MAX_MS) return clearInterval(this.reportTimer);
      try {
        const m = await breign.getMeeting(meeting.id);
        if (epoch !== this.epoch) return;
        this.meeting = m;
        this.events.onMeeting?.(m);
        if ((m.notes?.version ?? 0) > version) clearInterval(this.reportTimer);
      } catch {
        /* réessai au prochain tour */
      }
    }, REPORT_POLL_MS);
  }

  /** Message écrit de l'hôte : ajouté à la transcription et traité comme une interpellation. */
  async sendText(text: string) {
    const meeting = this.meeting;
    if (!meeting || !this.active) return false;
    try {
      await this.getBreign().meetingMessage(meeting.id, text);
      void this.pollSegments();
      return true;
    } catch (e) {
      this.events.onError?.(await describeError(e));
      return false;
    }
  }

  // ------------------------------------------------------------------------------ interne

  private async capture(source: MeetingSource, micStream?: MediaStream) {
    if (source === 'mic') {
      if (micStream) return { stream: micStream, owns: false };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        return { stream, owns: true };
      } catch {
        this.events.onError?.('Micro indisponible : autorisez-le pour que l’avatar écoute la pièce.');
        return undefined;
      }
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.events.onError?.('La capture d’onglet (getDisplayMedia) n’est pas disponible dans ce navigateur.');
      return undefined;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // Chrome n'accorde l'audio d'un onglet que si la vidéo est demandée : on la coupe après.
        video: { displaySurface: 'browser' } as MediaTrackConstraints,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } catch {
      return undefined; // partage annulé par l'utilisateur
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      this.events.onError?.(
        'Aucun son capturé : partagez un onglet en cochant « Partager l’audio de l’onglet », ou l’écran entier avec le son du système.',
      );
      return undefined;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    // Arrêt du partage depuis la barre du navigateur : on met la réunion en pause.
    audioTracks[0].addEventListener('ended', () => {
      if (this.stream === stream) this.pause();
    });
    return { stream, owns: true };
  }

  /** Reprend la réunion active de cet appareil, sinon en démarre une nouvelle. */
  private async openMeeting(breign: BreignService) {
    const previous = recalled();
    if (previous) {
      try {
        const resumed = await breign.resumeMeeting(previous);
        if (resumed.meeting.status === 'active') return resumed;
      } catch {
        /* terminée (409) ou supprimée : on en démarre une nouvelle */
      }
      forget(previous);
    }
    const title = `Réunion du ${new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
    return breign.startMeeting(title);
  }

  private release() {
    if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.ownsStream = false;
  }

  /** Reprise : affiche la fin de la transcription déjà enregistrée, sans la redire. */
  private async loadHistory(meetingId: string) {
    const last = this.meeting?.lastSegmentSeq ?? 0;
    if (!last) return;
    try {
      const from = Math.max(1, last - RESUME_LINES + 1);
      const segments = await this.getBreign().meetingSegments(meetingId, from, RESUME_LINES);
      this.accept(segments);
    } catch (e) {
      console.warn('[meeting] transcription précédente illisible', e);
    }
  }

  private async pollSegments() {
    const meeting = this.meeting;
    if (!meeting || this.polling || !this.active) return;
    this.polling = true;
    const epoch = this.epoch;
    try {
      const segments = await this.getBreign().meetingSegments(meeting.id, this.lastSeq + 1);
      if (epoch === this.epoch) this.accept(segments);
    } catch (e) {
      console.warn('[meeting] segments illisibles', e);
    } finally {
      this.polling = false;
    }
  }

  /** Affiche les nouveaux segments et fait dire les nouvelles réponses de l'agent. */
  private accept(segments: MeetingSegmentUio[]) {
    const fresh = segments.filter((s) => s.seq > this.lastSeq).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    this.lastSeq = fresh[fresh.length - 1].seq;
    const start = this.meeting?.startedAt ? new Date(this.meeting.startedAt).getTime() : Date.now();
    const lines = fresh.map<MeetingLine>((s) => ({
      seq: s.seq,
      time: clock(start + (s.startMs ?? 0)),
      text: s.text,
      speaker: s.speaker,
      source: s.source === 'agent' ? 'agent' : 'transcript',
      addressed: Boolean(s.addressed),
      ignored: s.ignored,
    }));
    this.events.onLines?.(lines);
    const replies = fresh.filter((s) => s.source === 'agent' && s.seq > this.spokenUntil);
    if (replies.length) {
      this.spokenUntil = replies[replies.length - 1].seq;
      const text = replies.map((s) => s.text).join(' ');
      // Breign dit lui-même les réponses quand l'agent a une « app qui prête sa voix »
      // (`agent.audio`). Sinon, après un court délai, la voix de l'app configurée ici.
      if (this.speakReplies() && !this.serverVoice) {
        const epoch = this.epoch;
        const seen = this.lastAudioAt;
        window.setTimeout(() => {
          if (epoch === this.epoch && !this.serverVoice && this.lastAudioAt === seen) this.conversation.speak(text);
        }, SERVER_VOICE_GRACE_MS);
      }
      void this.refreshMeeting(); // une réponse va souvent avec un point clé
    }
  }

  /** Trames propres à la réunion sur le WebSocket de transcription. */
  private onFrame(f: TranscriptFrame) {
    if (f.type === 'agent.audio') return this.onAgentAudio(f);
    if (f.type === 'agent.update') {
      // Réponse, notes ou points clés mis à jour : on relit sans attendre le prochain tour.
      void this.pollSegments();
      void this.refreshMeeting();
      return;
    }
    if (f.type !== 'usage') console.debug('[meeting] trame', f);
  }

  /**
   * Voix de l'agent, synthétisée par Breign avec l'app qui lui prête sa voix. Le format exact
   * de la trame n'est pas documenté : on accepte une URL (`audio.src`, `src`, `url`) ou de
   * l'audio en base64 (`audio.data`, `data`), encodé (mp3, wav…) ou PCM16 brut.
   */
  private onAgentAudio(f: TranscriptFrame) {
    this.serverVoice = true;
    this.lastAudioAt = Date.now();
    if (!this.speakReplies()) return;
    const src = agentAudioSrc(f);
    const text = String(f.text ?? (f.audio as { text?: string } | undefined)?.text ?? '');
    if (!src && !text) return console.warn('[meeting] trame agent.audio illisible', f);
    console.info('[meeting] agent.audio', describeFrame(f));
    // Une nouvelle réponse : autre message, première phrase, ou l'avatar avait fini de parler.
    // Les morceaux suivants d'une réponse en cours s'ajoutent à la file, sans couper le
    // précédent (seul un identifiant de *réponse* compte, pas celui d'un morceau).
    const key = String(f.messageId ?? f.wakeupId ?? f.replyId ?? f.turnId ?? '');
    const sequence = typeof f.sequence === 'number' ? f.sequence : undefined;
    const starts =
      sequence !== undefined
        ? sequence === 0 && !(key && key === this.audioReply && this.voice.busy)
        : key
          ? key !== this.audioReply
          : !this.voice.busy && Date.now() - this.lastChunkAt > 1500;
    this.audioReply = key || undefined;
    this.lastChunkAt = Date.now();
    this.conversation.speakPrepared(text, src, starts);
  }

  private async refreshMeeting() {
    const meeting = this.meeting;
    if (!meeting) return;
    const epoch = this.epoch;
    try {
      const m = await this.getBreign().getMeeting(meeting.id);
      if (epoch !== this.epoch) return;
      this.meeting = m;
      this.events.onMeeting?.(m);
      if (m.status === 'ended' && this.active) {
        // Terminée ailleurs (interface Breign, 15 min sans audio) : on arrête d'écouter.
        forget(m.id);
        this.pause();
        this.events.onError?.('La réunion a été terminée.');
      }
    } catch (e) {
      console.warn('[meeting] état de la réunion illisible', e);
    }
  }
}

/** Trame `agent.audio` résumée pour la console (sans l'audio en base64). */
function describeFrame(f: TranscriptFrame) {
  const short = (v: unknown) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 40)}… (${v.length} car.)` : v);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, short(b)])) : short(v);
  }
  return out;
}

/** Source jouable de l'audio d'une trame `agent.audio` (URL, data URL ou blob WAV). */
export function agentAudioSrc(f: TranscriptFrame): string | undefined {
  const a = (typeof f.audio === 'object' && f.audio ? f.audio : {}) as Record<string, unknown>;
  const url = a.src ?? a.url ?? f.src ?? f.url ?? f.audioUrl ?? (typeof f.audio === 'string' && /^(https?:|data:|blob:|\/)/.test(f.audio) ? f.audio : undefined);
  if (typeof url === 'string' && url) return url;
  const data = a.data ?? a.base64 ?? f.data ?? (typeof f.audio === 'string' ? f.audio : undefined);
  if (typeof data !== 'string' || !data) return undefined;
  const format = String(a.encoding ?? a.format ?? a.mimeType ?? f.encoding ?? f.format ?? f.mimeType ?? 'audio/mpeg').toLowerCase();
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  if (format.includes('pcm')) {
    // PCM16 brut : on l'enveloppe en WAV pour que le navigateur sache le décoder.
    const rate = Number(a.sampleRate ?? f.sampleRate) || 24000;
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    return URL.createObjectURL(encodeWav(samples, rate));
  }
  const mime = format.includes('/') ? format : `audio/${format === 'mp3' ? 'mpeg' : format}`;
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function remember(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* stockage indisponible */
  }
}

function recalled(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function forget(id: string) {
  try {
    if (localStorage.getItem(STORAGE_KEY) === id) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible */
  }
}
