import type { Avatar, Expression } from '../avatar/Avatar';
import { SentenceChunker, type Voice } from '../avatar/Voice';
import { describeError, type BreignService } from '../breign/BreignService';
import { toWav16k, VoiceActivity, type Utterance } from './VoiceActivity';

export type ConversationState = 'off' | 'idle' | 'user-speaking' | 'transcribing' | 'thinking' | 'speaking';

export interface ConversationEvents {
  onState?: (s: ConversationState) => void;
  onUserText?: (text: string) => void;
  /** Texte de la réponse en cours (cumulatif), `done` à la fin. */
  onAgentText?: (text: string, done: boolean) => void;
  onError?: (message: string) => void;
  onLevel?: (level: number) => void;
}

/**
 * Chef d'orchestre de la conversation vocale, sans bouton :
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

  constructor(
    private voice: Voice,
    private getBreign: () => BreignService,
    private getAvatar: () => Avatar | undefined,
    private events: ConversationEvents = {},
  ) {
    this.vad = new VoiceActivity(voice.ctx);
    this.vad.onSpeechStart = (bargeIn) => this.userStarted(bargeIn);
    this.vad.onSpeechEnd = (u) => void this.userFinished(u);
    this.vad.onSpeechCancel = () => this.userCancelled();
    this.vad.onLevel = (level, speaking) => {
      this.events.onLevel?.(level);
      this.getAvatar()?.setUserLevel(speaking ? level : 0);
    };
    voice.onSpeakingChange = (speaking) => {
      this.vad.avatarSpeaking = speaking;
      if (speaking) this.setState('speaking');
      else if (this.state === 'speaking') this.setState('idle');
    };
  }

  get current() {
    return this.state;
  }

  /** Démarre l'écoute (à appeler depuis un geste utilisateur). */
  async start() {
    this.voice.unlock();
    await this.vad.start();
    this.setState('idle');
  }

  stop() {
    this.interrupt();
    this.vad.stop();
    this.setState('off');
  }

  /** Coupe l'avatar et abandonne la réponse en cours. */
  interrupt() {
    this.turn++;
    this.abort?.abort();
    this.voice.stop();
  }

  /** Message tapé au clavier : même parcours qu'un message dit à voix haute. */
  sendText(text: string) {
    this.interrupt();
    this.openUserText = '';
    void this.respond(text.trim());
  }

  private userStarted(bargeIn: boolean) {
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
    // Bruit bref : on revient à l'état précédent si rien n'a été interrompu.
    if (this.state === 'user-speaking') this.setState(this.openUserText ? 'thinking' : 'idle');
    if (!this.openUserText) this.getAvatar()?.setMode('idle');
  }

  private async userFinished(u: Utterance) {
    const turn = ++this.turn;
    const breign = this.getBreign();
    if (!breign.configured) {
      this.events.onError?.('Renseignez une clé API et un agent dans les réglages (⚙) pour discuter.');
      this.setState('idle');
      return;
    }
    this.setState('transcribing');
    const avatar = this.getAvatar();
    avatar?.nod();
    avatar?.setMode('thinking');
    try {
      const wav = await toWav16k(u);
      const text = (await breign.speechToText(wav)).trim();
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
      this.events.onError?.('Renseignez une clé API et un agent dans les réglages (⚙) pour discuter.');
      return;
    }
    this.setState('thinking');
    avatar?.setMode('thinking');
    avatar?.setExpression('thinking', 0.5);
    this.avatarStartedSpeaking = false;
    const chunker = new SentenceChunker();
    const abort = (this.abort = new AbortController());

    const speak = (sentences: string[], full: string) => {
      for (const s of sentences) {
        if (!this.avatarStartedSpeaking) {
          this.avatarStartedSpeaking = true;
          this.openUserText = ''; // le tour de l'utilisateur est clos : l'avatar répond
          avatar?.setMode('speaking');
          avatar?.setExpression(moodOf(full), 0.6);
        }
        this.voice.say(s);
      }
    };

    try {
      const final = await breign.send(
        text,
        ({ text: partial, done }) => {
          if (turn !== this.turn) return;
          this.events.onAgentText?.(partial, done);
          speak(chunker.push(partial, done), partial);
        },
        abort.signal,
      );
      if (turn !== this.turn) return;
      this.events.onAgentText?.(final, true);
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
