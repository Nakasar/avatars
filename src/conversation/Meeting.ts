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
  // En réunion, on ne coupe l'avatar que pour une vraie prise de parole, pas pour un « hmm ».
  bargeInStartMs: 900,
};

/** Lignes de transcription gardées en mémoire : toute la réunion, pour l'outil de recherche. */
const MEMORY_LINES = 5000;
/** Lignes récentes transmises à l'agent quand on l'appelle, pour le contexte de la réunion. */
const CONTEXT_LINES = 12;
/** Outil TRANSCRIPT_SEARCH : nombre max de passages renvoyés, et taille max du résultat. */
const SEARCH_LIMIT = 40;
const SEARCH_MAX_CHARS = 8000;
/** Sans requête, l'outil renvoie la fin de la transcription (ce nombre de lignes). */
const TAIL_LINES = 100;

/**
 * Mode réunion : l'avatar devient un participant actif. Il écoute la réunion — l'audio d'un
 * onglet de visioconférence (`getDisplayMedia`) ou le micro de l'appareil posé dans la pièce —
 * le découpe en énoncés (VAD), transcrit chaque énoncé (STT Breign) dans un panneau, et quand
 * le mot d'activation est prononcé (« Breign, … »), il interrompt ce qu'il fait, envoie la
 * question à l'agent (avec les dernières lignes de la transcription en contexte) et répond de
 * vive voix. En mode « mic », sa propre voix (retour des enceintes) est reconnue et ignorée.
 *
 * Pendant que l'avatar parle, les seuils du VAD sont relevés (barge-in) : si quelqu'un de la
 * réunion prend vraiment la parole (près d'une seconde), l'avatar se tait. Une réponse en
 * préparation n'est jamais abandonnée parce que la réunion continue de parler.
 */
export class MeetingSession {
  private vad?: VoiceActivity;
  private stream?: MediaStream;
  private ownsStream = false;
  private source?: MeetingSource;
  /** Incrémenté à l'arrêt : les transcriptions encore en cours d'une session close sont ignorées. */
  private epoch = 0;
  /** Numéro du prochain énoncé, et du prochain à verser dans la transcription (ordre de parole). */
  private nextSeq = 0;
  private nextToFlush = 0;
  /** Transcriptions arrivées en avance (STT plus rapide pour un énoncé plus récent). */
  private ready = new Map<number, { time: string; text: string }>();
  /** Le VAD de la réunion est au milieu d'un énoncé. */
  private inSpeech = false;
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
    vad.onSpeechStart = (bargeIn) => {
      this.inSpeech = true;
      this.conversation.noteSpeechStart(bargeIn);
    };
    vad.onSpeechEnd = (u) => {
      this.inSpeech = false;
      void this.onUtterance(u);
    };
    // Bruit bref (toux, clic) : rien à transcrire, on rend la main.
    vad.onSpeechCancel = () => {
      this.inSpeech = false;
      this.releaseIfQuiet();
    };
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
    this.epoch++;
    this.inSpeech = false;
    this.ready.clear();
    this.nextToFlush = this.nextSeq;
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

  /**
   * Outil local `TRANSCRIPT_SEARCH` : consulte toute la transcription de la réunion gardée
   * en mémoire. Sans requête : la fin de la transcription. Avec une requête : les passages
   * qui contiennent le plus de ses mots, classés par pertinence (puis par ancienneté).
   */
  searchTranscript(query = ''): string {
    const fmt = (l: TranscriptLine) => `${l.time} — ${l.text}`;
    const clip = (s: string) =>
      s.length > SEARCH_MAX_CHARS ? `${s.slice(0, SEARCH_MAX_CHARS)}\n… (tronqué)` : s;
    const terms = normalizeForMatch(query).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!terms.length) {
      const tail = this.lines.slice(-TAIL_LINES);
      return clip(`Fin de la transcription (${tail.length}/${this.lines.length} dernières lignes) :\n${tail.map(fmt).join('\n')}`);
    }
    const scored: Array<{ l: TranscriptLine; score: number }> = [];
    for (const l of this.lines) {
      const t = normalizeForMatch(l.text);
      let score = 0;
      for (const term of terms) if (t.includes(term)) score++;
      if (score) scored.push({ l, score });
    }
    // Tri stable : à pertinence égale, l'ordre chronologique est conservé.
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, SEARCH_LIMIT);
    return clip(
      `${scored.length} passage(s) sur ${this.lines.length} lignes pour « ${query.trim()} » (les ${picked.length} plus pertinents) :\n${picked.map((s) => fmt(s.l)).join('\n')}`,
    );
  }

  private isEcho(text: string) {
    return isEchoOf(text, this.agentSpeech);
  }

  /** Plus personne ne parle et aucune transcription n'est en attente : l'avatar rend la main. */
  private releaseIfQuiet() {
    if (!this.inSpeech && this.nextToFlush === this.nextSeq) this.conversation.noteSpeechEnd();
  }

  /**
   * Transcrit un énoncé de la réunion. Les énoncés sont transcrits en parallèle (le STT peut
   * être plus lent que la parole) mais versés dans la transcription dans l'ordre où ils ont été
   * dits : aucun n'est perdu quand un autre se termine pendant sa transcription.
   */
  private async onUtterance(u: Utterance) {
    const epoch = this.epoch;
    const seq = this.nextSeq++;
    const time = timestamp(); // heure de la parole, pas de la fin de la transcription
    let text = '';
    const breign = this.getBreign();
    if (breign.configured) {
      try {
        text = await this.conversation.transcribe(u);
      } catch (e) {
        const message = await describeError(e);
        if (epoch === this.epoch) this.events.onError?.(message);
      }
    }
    if (epoch !== this.epoch) return;
    this.ready.set(seq, { time, text });
    while (this.ready.has(this.nextToFlush)) {
      const r = this.ready.get(this.nextToFlush)!;
      this.ready.delete(this.nextToFlush++);
      if (r.text) this.addLine(r.time, r.text);
    }
    this.releaseIfQuiet();
  }

  /** Ajoute une ligne à la transcription ; appelle l'avatar si le mot d'activation est présent. */
  private addLine(time: string, text: string) {
    // En mode « mic », l'appareil peut entendre sa propre voix (enceintes) : on la reconnaît
    // au chevauchement de mots avec ce que l'avatar vient de dire, et elle ne déclenche rien.
    const self = this.isEcho(text);
    // Le mot d'activation réglé, plus les noms génériques (« agent », « bot », « robot »).
    const hit = self ? null : findWakeWord(text, [this.getWakeWord(), ...GENERIC_WAKE_WORDS]);
    const line: TranscriptLine = { time, text, addressed: Boolean(hit), self };
    this.lines.push(line);
    if (this.lines.length > MEMORY_LINES) this.lines.shift();
    this.events.onTranscript?.(line);
    if (!hit) return;
    const question = questionFor(text, hit);
    const context = this.lines.slice(-CONTEXT_LINES).map((l) => `${l.time} — ${l.text}`).join('\n');
    const en = this.getBreign().settings.lang.startsWith('en');
    const message = en
      ? `[Meeting transcript — last lines]\n${context}\n\n[You are being addressed in the meeting]: “${question}”`
      : `[Transcription de la réunion — dernières lignes]\n${context}\n\n[On s’adresse à toi dans la réunion] : « ${question} »`;
    this.conversation.sendText(message);
  }
}

/** Ponctuation et espaces sans contenu (« ? », « , », « … ») autour d'un fragment. */
const EDGE_PUNCT = /^[\s,.;:!?…«»"“”'’()\-–—]+|[\s,.;:!?…«»"“”'’()\-–—]+$/g;

/**
 * La question posée à l'avatar : ce qui suit le mot d'activation (« Breign, quelles sont les
 * étapes ? »). Quand le mot est en fin de phrase (« Qu'en penses-tu, Breign ? »), ce qui suit
 * n'est que de la ponctuation : on garde alors la phrase entière, que l'agent comprend très bien.
 */
export function questionFor(text: string, hit: { index: number; length: number }): string {
  const after = text.slice(hit.index + hit.length).replace(EDGE_PUNCT, '');
  if (/[\p{L}\p{N}]/u.test(after)) return text.slice(hit.index + hit.length).replace(/^[\s,.;:!\-–—]+/, '').trim();
  return text.trim();
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
 * Noms génériques qui appellent aussi l'avatar en réunion, en plus du mot d'activation
 * réglé (« Breign, … » mais aussi « Agent, … », « Bot, … », « Robot, … »).
 */
export const GENERIC_WAKE_WORDS = ['agent', 'bot', 'robot'];

/**
 * Cherche un mot d'activation dans `text` (un ou plusieurs) : correspondance exacte
 * (frontières de mot, insensible à la casse et aux accents), puis **variantes phonétiques**
 * (« Brain », « Bren » pour « breign ») via une clé phonétique française simplifiée, puis
 * petite distance d'édition pour les fautes d'orthographe. Renvoie la position, dans le texte
 * d'origine, de la première occurrence trouvée.
 */
export function findWakeWord(text: string, wake: string | string[]): { index: number; length: number } | null {
  const wakes = (Array.isArray(wake) ? wake : [wake])
    .map((w) => normalizeForMatch(w).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let best: { index: number; length: number } | null = null;
  for (const w of wakes) {
    const hit = findOneWakeWord(text, w);
    if (hit && (!best || hit.index < best.index)) best = hit;
  }
  return best;
}

function findOneWakeWord(text: string, w: string): { index: number; length: number } | null {
  // 1. Correspondance exacte sur le texte normalisé (la normalisation conserve la longueur :
  //    les index sont valables dans le texte d'origine).
  const pattern = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const m = new RegExp(`(^|[^a-z0-9])${pattern}(?![a-z0-9])`).exec(normalizeForMatch(text));
  if (m) return { index: m.index + m[1].length, length: m[0].length - m[1].length };
  // 2. Variantes phonétiques, mot par mot (jamais à l'intérieur d'un mot plus long).
  const wakeWords = w.split(' ').filter(Boolean);
  const wakeKeys = wakeWords.map(phoneticKey);
  if (!wakeKeys.length || wakeKeys.some((k) => !k)) return null;
  const words: Array<{ i: number; w: string }> = [];
  const re = /[a-z0-9\u2019']+/g;
  let x: RegExpExecArray | null;
  const normalized = normalizeForMatch(text);
  while ((x = re.exec(normalized))) words.push({ i: x.index, w: x[0] });
  for (let k = 0; k + wakeWords.length <= words.length; k++) {
    const slice = words.slice(k, k + wakeWords.length);
    if (slice.map((s) => phoneticKey(s.w)).every((key, j) => key === wakeKeys[j])) {
      const last = slice[slice.length - 1];
      return { index: slice[0].i, length: last.i + last.w.length - slice[0].i };
    }
    if (wakeWords.length === 1) {
      const d = levenshtein(slice[0].w, wakeWords[0]);
      const max = wakeWords[0].length >= 7 ? 2 : wakeWords[0].length >= 4 ? 1 : 0;
      if (d > 0 && d <= max) return { index: slice[0].i, length: slice[0].w.length };
    }
  }
  return null;
}

/**
 * Clé phonétique simplifiée (français) : digrammes usuels, voyelles réduites, lettres muettes
 * finales supprimées, doubles aplatis. Deux mots qui « sonnent pareil » ont la même clé
 * (« breign », « brain », « bren » → « bren »).
 */
export function phoneticKey(s: string): string {
  let t = normalizeForMatch(s).replace(/['\u2019]/g, '');
  t = t
    .replace(/qu/g, 'k')
    .replace(/ch/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/gn/g, 'n')
    .replace(/eau/g, 'o')
    .replace(/au/g, 'o')
    .replace(/ou/g, 'u')
    .replace(/oi/g, 'wa')
    .replace(/ai|ei|ey/g, 'e')
    .replace(/eu/g, 'e')
    .replace(/y/g, 'i')
    .replace(/ill/g, 'i')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/g(?=n)/g, '')
    .replace(/[estdzx]$/g, '')
    .replace(/(.)\1+/g, '$1');
  return t;
}

/** Distance de Levenshtein (insertion/suppression/substitution = 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}
