import type { Expression } from '../avatar/Avatar';
import type { Character } from '../avatar/Character';
import { SentenceChunker, type Voice } from '../avatar/Voice';
import { describeError, type BreignService } from '../breign/BreignService';
import type { NativeAction } from '../breign/nativeActions';
import { safeStreamingText, stripActions } from '../actions/parse';
import { toWav16k, VoiceActivity, type Utterance } from './VoiceActivity';
import { AppReplies } from './AppReplies';
import type { AppMessage } from '../breign/AppSocket';
import { TranscriptionStream, type TranscriptFrame } from '../breign/TranscriptionStream';

/** Audio gardé avant le début de la parole, envoyé avec elle (première syllabe). */
const STREAM_PREROLL_FRAMES = 20; // 20 × 20 ms
/** Audio encore envoyé après la fin de la parole détectée, avant `commit`. */
const STREAM_TAIL_MS = 300;
/** Sans `avatar.turn` dans ce délai après la fin de la parole, l'avatar rend la main. */
const TURN_WAIT_MS = 10_000;

export type ConversationState = 'off' | 'idle' | 'user-speaking' | 'transcribing' | 'thinking' | 'speaking';

export interface ConversationEvents {
  onState?: (s: ConversationState) => void;
  onUserText?: (text: string) => void;
  /** Texte de la réponse en cours (cumulatif), `done` à la fin. */
  onAgentText?: (text: string, done: boolean) => void;
  onError?: (message: string) => void;
  onLevel?: (level: number) => void;
  /** Actions natives de la réponse (montrer une image, ouvrir une page…), à sa fin. */
  onNativeActions?: (actions: NativeAction[]) => void;
  /** Transcription en direct : `live` vrai tant que le flux est ouvert. */
  onLiveTranscription?: (live: boolean) => void;
  /** Une nouvelle réponse commence à être dite. */
  onReplyStart?: () => void;
  /** `DO_ACTION` de l'application, au moment de sa phrase. */
  onAppAction?: (action: NonNullable<AppMessage['action']>) => void;
  /** Relances proposées en fin de réponse (`SHOW_SUGGESTIONS`). */
  onSuggestions?: (s: NonNullable<AppMessage['suggestions']>) => void;
}

/**
 * Chef d'orchestre de la conversation vocale, sans bouton.
 *
 * **Transcription en flux** (app Breign et conversation ouverte) : le micro est streamé vers
 * la session de transcription de la conversation (`POST /apps/{appId}/chats/{chatId}/
 * transcription-sessions`). Breign transcrit en direct (`transcript.partial`), envoie lui-même
 * chaque tour à l'agent (`avatar.turn`) et la réponse arrive sur la web socket de l'app. Le
 * VAD local ne sert plus qu'à deux choses : n'envoyer l'audio que quand quelqu'un parle (ni
 * la pièce silencieuse, ni la voix de l'avatar revenue par les enceintes), et couper l'avatar
 * quand on lui parle (barge-in).
 *
 * **Sinon** (premier message, mode agent sans app, déploiement sans flux) : chaque énoncé est
 * découpé par le VAD, transcrit (`speech-to-text`) puis envoyé, comme avant :
 *
 *   écoute ──(voix détectée)──▶ l'utilisateur parle ──(silence)──▶ transcription
 *      ▲                                                               │
 *      └──── l'avatar parle ◀──(1re phrase prête)── réflexion ◀────────┘
 *
 * Interruptions :
 *  - si l'utilisateur reprend la parole pendant la réflexion, la réponse en cours est
 *    abandonnée et sa nouvelle phrase est ajoutée à la précédente (il n'avait pas fini) ;
 *  - s'il parle pendant que l'avatar parle (barge-in), l'avatar se tait aussitôt et écoute.
 */
export class Conversation {
  readonly vad: VoiceActivity;
  private state: ConversationState = 'off';
  /** Incrémenté à chaque nouveau tour : les réponses d'un tour périmé sont ignorées. */
  private turn = 0;
  private abort?: AbortController;
  /** Ce que l'utilisateur a dit depuis la dernière réponse prononcée (tour « ouvert »). */
  private openUserText = '';
  private avatarStartedSpeaking = false;
  /** Réponses de l'application, reçues sur sa web socket. */
  readonly replies: AppReplies;
  /**
   * Mode application : la question part par `POST /apps/{appId}/chats` et la réponse (voix
   * déjà synthétisée, images, actions) arrive sur la web socket. Sinon, mode agent : la
   * réponse est suivie par l'API des prompts et synthétisée phrase par phrase.
   */
  appMode = false;

  /** Flux de transcription de la conversation de l'app (absent : énoncés transcrits un à un). */
  private stream?: TranscriptionStream;
  /** Conversation pour laquelle le flux est ouvert (une nouvelle conversation, un nouveau flux). */
  private streamChat?: string;
  /** Le flux n'est pas disponible (501, modèle sans flux…) : on ne réessaie plus. */
  private streamUnavailable = false;
  private preRoll: Float32Array[] = [];
  /** L'audio du micro part dans le flux (quelqu'un parle, ou fin de phrase). */
  private sending = false;
  private tailMs = 0;
  private turnTimer?: number;
  /** Transcription en direct de la phrase en cours (cumul des segments). */
  private liveText = new Map<string, string>();

  constructor(
    private voice: Voice,
    private getBreign: () => BreignService,
    private getAvatar: () => Character | undefined,
    private events: ConversationEvents = {},
  ) {
    this.vad = new VoiceActivity(voice.ctx);
    this.vad.onSpeechStart = (bargeIn) => this.userStarted(bargeIn);
    this.vad.onSpeechEnd = (u) => void this.userFinished(u);
    this.vad.onSpeechCancel = () => this.userCancelled();
    this.vad.onFrame = (f, rate) => this.onMicFrame(f, rate);
    this.vad.onLevel = (level, speaking) => {
      this.events.onLevel?.(level);
      this.getAvatar()?.setUserLevel(speaking ? level : 0);
    };
    voice.onSpeakingChange = (speaking) => {
      this.vad.avatarSpeaking = speaking;
      if (speaking) this.setState('speaking');
      // Entre deux phrases d'une réponse en streaming, l'avatar reste « en train de parler ».
      else if (this.state === 'speaking' && !(this.appMode && this.replies.active)) this.setState('idle');
    };
    this.replies = new AppReplies(voice, {
      onTurnStart: () => this.replyStarted(),
      onText: (text, done) => this.events.onAgentText?.(stripActions(text), done),
      onTurnEnd: () => {
        void this.getBreign().setAppIdle().catch(() => undefined);
        if (!this.voice.speaking) {
          this.setState('idle');
          this.getAvatar()?.setMode('idle');
        }
      },
      onAction: (a) => this.events.onAppAction?.(a),
      onImage: (img) =>
        this.events.onNativeActions?.([{ code: 'SHOW_IMAGE', kind: 'image', url: img.src, title: img.title, raw: img }]),
      onSuggestions: (list) => this.events.onSuggestions?.(list),
      onInput: (text) => {
        this.events.onUserText?.(text);
        this.setState('thinking');
        this.getAvatar()?.setMode('thinking');
      },
      onInterrupt: () => this.setState('idle'),
    });
  }

  /** Message reçu sur la web socket de l'application. */
  onAppMessage(m: AppMessage) {
    this.replies.handle(m);
  }

  /** Début d'une réponse : l'avatar passe en mode parole, les effets précédents s'arrêtent. */
  private replyStarted(mood?: Expression) {
    this.avatarStartedSpeaking = true;
    this.openUserText = ''; // le tour de l'utilisateur est clos : l'avatar répond
    const avatar = this.getAvatar();
    avatar?.resetActions?.();
    this.events.onReplyStart?.();
    avatar?.setMode('speaking');
    avatar?.setExpression(mood ?? 'neutral', 0.6);
  }

  get current() {
    return this.state;
  }

  /** Démarre l'écoute (à appeler depuis un geste utilisateur). */
  async start() {
    this.voice.unlock();
    await this.vad.start();
    this.setState('idle');
    void this.ensureStream();
  }

  stop() {
    this.interrupt();
    this.closeStream();
    this.vad.stop();
    this.setState('off');
  }

  /** La transcription en flux est ouverte (ou en reconnexion). */
  get live() {
    return Boolean(this.stream && this.stream.state !== 'failed' && this.stream.state !== 'closed');
  }

  /**
   * Ouvre le flux de transcription si c'est possible : app connectée, conversation déjà
   * ouverte (le flux s'y rattache), micro démarré. Appelée au démarrage et après chaque réponse.
   */
  async ensureStream() {
    const breign = this.getBreign();
    const chat = breign.appConversationId;
    if (!this.appMode || !chat || this.state === 'off' || this.streamUnavailable) return;
    if (this.stream && this.streamChat === chat) return;
    this.closeStream();
    this.streamChat = chat;
    const stream = new TranscriptionStream({
      basePath: breign.settings.basePath,
      open: () => breign.openAppTranscription(),
      onPartial: (id, text) => this.onLiveText(id, text),
      onFinal: (f) => this.onLiveText(f.itemId ?? '', f.text ?? '', true),
      onFrame: (f) => this.onStreamFrame(f),
      onState: (st, detail) => {
        if (stream !== this.stream) return;
        if (st === 'failed') {
          this.closeStream();
          this.streamUnavailable = true;
          if (detail) this.events.onError?.(`${detail} Retour à la transcription phrase par phrase.`);
        }
        this.events.onLiveTranscription?.(this.live);
      },
    });
    this.stream = stream;
    try {
      await stream.connect();
      console.info('[conversation] transcription en flux :', stream.mode, stream.model);
    } catch (e) {
      if (stream !== this.stream) return;
      this.closeStream();
      // 501 (déploiement sans flux), 400 (modèle incapable de streamer…) : phrase par phrase.
      this.streamUnavailable = true;
      console.info('[conversation] transcription en flux indisponible :', await describeError(e));
    }
  }

  /** Ferme le flux (changement de réglages, arrêt) ; `retry` autorise une nouvelle tentative. */
  closeStream(retry = false) {
    const stream = this.stream;
    this.stream = undefined;
    this.streamChat = undefined;
    this.sending = false;
    this.preRoll = [];
    this.liveText.clear();
    clearTimeout(this.turnTimer);
    if (retry) this.streamUnavailable = false;
    if (stream) {
      stream.close();
      this.events.onLiveTranscription?.(false);
    }
  }

  /** Trame du micro (20 ms) : envoyée au flux seulement pendant la parole. */
  private onMicFrame(f: Float32Array, rate: number) {
    const stream = this.stream;
    if (!stream) return;
    if (!this.sending) {
      this.preRoll.push(f);
      if (this.preRoll.length > STREAM_PREROLL_FRAMES) this.preRoll.shift();
      return;
    }
    stream.pushAudio(f, rate);
    if (this.tailMs > 0) {
      this.tailMs -= (f.length / rate) * 1000;
      if (this.tailMs <= 0) {
        this.sending = false;
        stream.commit(); // fin du tour sans attendre la détection de silence du serveur
      }
    }
  }

  /** Début de parole : le flux reçoit la pré-écoute puis l'audio en direct. */
  private startSending() {
    if (!this.live) return;
    const rate = this.voice.ctx.sampleRate;
    if (!this.sending) for (const f of this.preRoll) this.stream!.pushAudio(f, rate);
    this.preRoll = [];
    this.sending = true;
    this.tailMs = 0;
  }

  private onLiveText(itemId: string, text: string, final = false) {
    if (final && !text.trim()) {
      this.liveText.delete(itemId);
      return;
    }
    this.liveText.set(itemId, text.trim());
    const all = [...this.liveText.values()].filter(Boolean).join(' ');
    if (all) this.events.onUserText?.(all);
  }

  /** Trames propres à la session de l'avatar : le tour transcrit est parti à l'agent. */
  private onStreamFrame(f: TranscriptFrame) {
    if (f.type === 'avatar.turn') {
      clearTimeout(this.turnTimer);
      const turn = f.turn as Record<string, unknown> | undefined;
      const text = String(f.text ?? turn?.text ?? f.message ?? [...this.liveText.values()].join(' ')).trim();
      const messageId = (f.messageId ?? turn?.messageId) as string | undefined;
      this.liveText.clear();
      if (text) this.events.onUserText?.(text);
      ++this.turn;
      this.abort?.abort();
      this.replies.awaitTurn(messageId);
      this.setState('thinking');
      const avatar = this.getAvatar();
      avatar?.setMode('thinking');
      avatar?.setExpression('thinking', 0.5);
      this.avatarStartedSpeaking = false;
      return;
    }
    if (f.type === 'avatar.turn_failed') {
      clearTimeout(this.turnTimer);
      this.liveText.clear();
      const reason = String(f.message ?? f.reason ?? f.code ?? '');
      void this.fail(new Error(`La question n’a pas pu être envoyée à l’agent${reason ? ` : ${reason}` : ''}.`));
      return;
    }
    if (f.type !== 'usage') console.debug('[transcription] trame', f);
  }

  /** Coupe l'avatar et abandonne la réponse en cours. */
  interrupt() {
    this.turn++;
    this.abort?.abort();
    this.voice.stop();
    if (this.replies.active) {
      // On se tait tout de suite, sans attendre l'aller-retour ; Breign est prévenu ensuite.
      this.replies.silence();
      if (this.appMode) void this.getBreign().interruptApp().catch(() => undefined);
    }
  }

  /** Message tapé au clavier : même parcours qu'un message dit à voix haute. */
  sendText(text: string) {
    this.interrupt();
    this.openUserText = '';
    void this.respond(text.trim());
  }

  /** Transcrit un énoncé (WAV 16 kHz) avec la configuration Breign. */
  async transcribe(u: Utterance): Promise<string> {
    const wav = await toWav16k(u);
    return (await this.getBreign().speechToText(wav)).trim();
  }

  /**
   * Fait dire un texte venu d'ailleurs (réponse de l'agent en réunion) : l'avatar se met en
   * mode parole, et la voix le synthétise (voix de l'app) en jouant ses codes d'action.
   */
  speak(text: string) {
    if (!text.trim()) return;
    this.interrupt();
    this.replyStarted(moodOf(stripActions(text)));
    this.events.onAgentText?.(stripActions(text, true), true);
    // Phrase par phrase : la première est synthétisée et dite sans attendre les suivantes
    // (une seule synthèse pour toute la réponse arrivait en un bloc, après un long silence).
    for (const sentence of new SentenceChunker().push(text, true)) this.voice.say(sentence);
  }

  /**
   * Fait dire une phrase dont l'audio vient de Breign (trame `agent.audio` du mode réunion) :
   * l'audio est joué tel quel, le lip-sync suit le son. `startsReply` ouvre une nouvelle
   * réponse (l'avatar se tait d'abord et passe en mode parole).
   */
  speakPrepared(text: string, audioSrc: string | undefined, startsReply: boolean) {
    if (startsReply) {
      this.interrupt();
      this.replyStarted(moodOf(stripActions(text)));
      this.spoken = [];
    }
    this.voice.sayPrepared({
      text,
      audioSrc,
      onStart: () => {
        const clean = stripActions(text, true).trim();
        if (clean) this.spoken.push(clean);
        this.events.onAgentText?.(this.spoken.join(' '), true);
      },
    });
  }
  private spoken: string[] = [];

  private userStarted(bargeIn: boolean) {
    this.startSending();
    const avatar = this.getAvatar();
    if (bargeIn || this.state === 'speaking') {
      // L'utilisateur coupe la parole : l'avatar se tait et l'écoute.
      this.interrupt();
      this.openUserText = '';
      avatar?.setExpression('surprised', 0.25);
    } else if (this.state === 'thinking' || this.state === 'transcribing') {
      // Il n'avait pas fini sa phrase : on abandonne la réponse, on garde ce qu'il a dit.
      this.interrupt();
    } else {
      this.openUserText = '';
    }
    avatar?.setMode('listening');
    setTimeout(() => avatar?.setExpression('listening', 0.8), 400);
    this.setState('user-speaking');
  }

  private userCancelled() {
    if (this.sending && this.tailMs <= 0) {
      // Toux, clic : rien à transcrire, l'audio déjà parti sera ignoré par le serveur.
      this.sending = false;
      this.stream?.drop();
    }
    // Bruit bref : on revient à l'état précédent si rien n'a été interrompu.
    if (this.state === 'user-speaking') this.setState(this.openUserText ? 'thinking' : 'idle');
    if (!this.openUserText) this.getAvatar()?.setMode('idle');
  }

  private async userFinished(u: Utterance) {
    if (this.live && this.sending) {
      // En flux : Breign transcrit et envoie le tour à l'agent lui-même (`avatar.turn`).
      this.tailMs = STREAM_TAIL_MS;
      this.setState('transcribing');
      const avatar = this.getAvatar();
      avatar?.nod();
      avatar?.setMode('thinking');
      const turn = this.turn;
      clearTimeout(this.turnTimer);
      this.turnTimer = window.setTimeout(() => {
        // Rien d'exploitable (bruit, mot inaudible) : l'avatar rend la main.
        if (turn === this.turn && this.state === 'transcribing') {
          this.setState('idle');
          avatar?.setMode('idle');
        }
      }, TURN_WAIT_MS);
      return;
    }
    const turn = ++this.turn;
    const breign = this.getBreign();
    if (!breign.configured) {
      this.events.onError?.('Connectez-vous avec Breign et choisissez un agent dans les réglages (⚙) pour discuter.');
      this.setState('idle');
      return;
    }
    this.setState('transcribing');
    const avatar = this.getAvatar();
    avatar?.nod();
    avatar?.setMode('thinking');
    try {
      const text = await this.transcribe(u);
      if (turn !== this.turn) return;
      if (!text) {
        this.setState('idle');
        avatar?.setMode('idle');
        return;
      }
      this.openUserText = this.openUserText ? `${this.openUserText} ${text}` : text;
      await this.respond(this.openUserText, turn);
    } catch (e) {
      if (turn !== this.turn) return;
      this.fail(e);
    }
  }

  private async respond(text: string, turn = ++this.turn) {
    if (!text) return;
    const breign = this.getBreign();
    const avatar = this.getAvatar();
    this.events.onUserText?.(text);
    if (!breign.configured) {
      this.events.onError?.('Connectez-vous avec Breign et choisissez un agent dans les réglages (⚙) pour discuter.');
      return;
    }
    this.setState('thinking');
    avatar?.setMode('thinking');
    avatar?.setExpression('thinking', 0.5);
    this.avatarStartedSpeaking = false;
    if (this.appMode) return this.respondByApp(text, turn);
    const chunker = new SentenceChunker();
    const abort = (this.abort = new AbortController());

    const speak = (sentences: string[], full: string) => {
      for (const s of sentences) {
        if (!this.avatarStartedSpeaking) this.replyStarted(moodOf(stripActions(full)));
        this.voice.say(s);
      }
    };

    try {
      const final = await breign.send(
        text,
        ({ text: partial, done }) => {
          if (turn !== this.turn) return;
          // Les codes d'action ne s'affichent pas ; la voix les déclenche en les lisant.
          this.events.onAgentText?.(stripActions(partial, done), done);
          speak(chunker.push(done ? partial : safeStreamingText(partial), done), partial);
        },
        abort.signal,
        (actions) => {
          if (turn === this.turn && actions.length) this.events.onNativeActions?.(actions);
        },
      );
      if (turn !== this.turn) return;
      this.events.onAgentText?.(stripActions(final), true);
      speak(chunker.push(final, true), final);
      if (!this.voice.speaking) {
        this.setState('idle');
        avatar?.setMode('idle');
      }
    } catch (e) {
      if (turn !== this.turn || (e as Error).name === 'AbortError') return;
      this.fail(e);
    }
  }

  /** Mode application : la réponse arrivera sur la web socket (voir `AppReplies`). */
  private async respondByApp(text: string, turn: number) {
    this.replies.begin();
    try {
      const messageId = await this.getBreign().askApp(text);
      // La conversation existe maintenant : les tours suivants passent par le flux.
      void this.ensureStream();
      if (turn !== this.turn) return;
      this.replies.expect(messageId);
    } catch (e) {
      if (turn !== this.turn) return;
      this.replies.silence();
      this.fail(e);
    }
  }

  private async fail(e: unknown) {
    this.events.onError?.(await describeError(e));
    this.setState('idle');
    this.getAvatar()?.setMode('idle');
    this.getAvatar()?.setExpression('sad', 0.3);
  }

  private setState(s: ConversationState) {
    if (s === this.state) return;
    this.state = s;
    if (s === 'idle') {
      const avatar = this.getAvatar();
      if (avatar && avatar.currentMode !== 'listening') avatar.setMode('idle');
      avatar?.setExpression('listening', 0.6);
    }
    this.events.onState?.(s);
  }
}

/** Humeur simple déduite du texte, pour colorer l'expression pendant la parole. */
export function moodOf(text: string): Expression {
  if (/[!😀😄😊🙂]|ravi|super|génial|parfait|bravo|great|glad|happy/i.test(text)) return 'happy';
  if (/désolé|malheureusement|sorry|unfortunately|hélas/i.test(text)) return 'sad';
  return 'neutral';
}
