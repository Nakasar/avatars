import type { Voice } from '../avatar/Voice';
import type { AppMessage } from '../breign/AppSocket';

export interface AppRepliesEvents {
  /** La première phrase d'une réponse commence. */
  onTurnStart?: (messageId: string) => void;
  /** Texte déjà dit de la réponse (cumulatif) ; `done` après la dernière phrase. */
  onText?: (text: string, done: boolean) => void;
  /** La dernière phrase (`final`) a été jouée. */
  onTurnEnd?: (messageId: string) => void;
  /** Action d'un `DO_ACTION`, au moment où la phrase de même `sequence` commence. */
  onAction?: (action: NonNullable<AppMessage['action']>) => void;
  /** Image d'un `SHOW_IMAGE`, au même moment. */
  onImage?: (image: NonNullable<AppMessage['image']>) => void;
  onSuggestions?: (s: NonNullable<AppMessage['suggestions']>) => void;
  /** Message d'utilisateur arrivé par un autre client (console d'opérateur…). */
  onInput?: (text: string) => void;
  /** Breign demande à l'avatar de se taire (`INTERRUPT`). */
  onInterrupt?: () => void;
}

type Say = AppMessage & { sequence: number };

/**
 * Joue les réponses reçues sur la web socket de l'application, tour par tour :
 *  - un tour = un `messageId` ; seules les phrases du tour en cours sont jouées, celles d'un
 *    tour interrompu sont ignorées (le serveur continue de les envoyer) ;
 *  - les `SAY` sont remis dans l'ordre des `sequence` (ils peuvent arriver dans le désordre),
 *    la phrase n n'est dite qu'après la n-1 ; leur audio (déjà synthétisé) est joué tel quel ;
 *  - `SHOW_IMAGE` et `DO_ACTION` sont rattachés à une `sequence` et déclenchés quand la phrase
 *    correspondante commence ;
 *  - `SAY_FILLER` meuble l'attente tant que rien d'autre n'est à dire.
 */
export class AppReplies {
  private current?: string;
  /** Une question vient d'être envoyée : le prochain tour qui arrive est le sien. */
  private awaiting = false;
  private ignored = new Set<string>();
  private pending = new Map<number, Say>();
  private next = 0;
  private finalSeq?: number;
  private started = -1;
  private attached = new Map<number, Array<() => void>>();
  private said: string[] = [];

  constructor(
    private voice: Voice,
    private events: AppRepliesEvents = {},
  ) {}

  /** Un tour est en cours (réponse attendue ou en train d'être dite). */
  get active() {
    return this.awaiting || Boolean(this.current);
  }

  /** On vient de poser une question : le tour précédent est abandonné. */
  begin() {
    this.silence();
    this.awaiting = true;
  }

  /** `messageId` renvoyé par la requête HTTP : c'est lui, le tour attendu. */
  expect(messageId?: string) {
    if (!messageId) return;
    if (this.current && this.current !== messageId) {
      // Un autre tour avait été adopté entre-temps : celui-ci l'emporte.
      this.ignored.add(this.current);
      this.reset();
    }
    this.current = messageId;
    this.awaiting = false;
  }

  /** Se tait et ignore la suite du tour en cours. */
  silence() {
    if (this.current) this.ignored.add(this.current);
    this.current = undefined;
    this.awaiting = false;
    this.reset();
  }

  handle(m: AppMessage) {
    const id = m.messageId;
    switch (m.type) {
      case 'INTERRUPT':
        if (this.active) {
          this.voice.stop();
          this.silence();
          this.events.onInterrupt?.();
        }
        return;
      case 'SHOW_SUGGESTIONS':
        if (id && this.owns(id)) this.events.onSuggestions?.(m.suggestions ?? []);
        return;
    }
    if (!id || this.ignored.has(id)) return;
    switch (m.type) {
      case 'INPUT': {
        // Question posée par un autre client (console d'opérateur…) quand l'avatar est libre.
        const fromUs = this.awaiting;
        if (this.adopt(id, !this.voice.busy) && !fromUs) this.events.onInput?.(m.text ?? '');
        return;
      }
      case 'SAY_FILLER':
        if (!this.adopt(id) || this.voice.busy || this.next > 0 || !m.audio?.src) return;
        this.voice.sayPrepared({ text: m.text ?? '', audioSrc: m.audio.src, silent: true });
        return;
      case 'SAY':
        // Un SAY sans question préalable (accueil du flow, POST /say) ouvre lui-même un tour.
        if (!this.adopt(id, m.sequence === 0 && !this.voice.busy)) return;
        this.onSay({ ...m, sequence: m.sequence ?? 0 });
        return;
      case 'SHOW_IMAGE':
        if (this.adopt(id) && m.image?.src) this.attach(m.sequence ?? 0, () => this.events.onImage?.(m.image!));
        return;
      case 'DO_ACTION':
        if (this.adopt(id) && m.action) this.attach(m.sequence ?? 0, () => this.events.onAction?.(m.action!));
        return;
    }
  }

  /** Le message appartient-il au tour en cours ? Adopte le tour attendu s'il arrive. */
  private adopt(id: string, openNew = false) {
    if (this.current === id) return true;
    if (!this.current && (this.awaiting || openNew)) {
      this.current = id;
      this.awaiting = false;
      this.reset();
      return true;
    }
    return false;
  }

  private owns(id: string) {
    return this.current === id || (!this.current && !this.ignored.has(id));
  }

  private onSay(say: Say) {
    if (say.sequence < this.next || this.pending.has(say.sequence)) return; // doublon (rejeu)
    this.pending.set(say.sequence, say);
    if (say.final) this.finalSeq = say.sequence;
    this.release();
  }

  /** Confie à la voix les phrases prêtes, dans l'ordre, sans trou. */
  private release() {
    const turn = this.current!;
    for (let s = this.pending.get(this.next); s; s = this.pending.get(this.next)) {
      this.pending.delete(this.next);
      const seq = this.next++;
      const text = s.text === '-' ? '' : (s.text ?? '');
      this.voice.sayPrepared({
        text,
        audioSrc: s.audio?.src,
        silent: s.text === '-',
        onStart: () => {
          if (turn !== this.current) return;
          if (seq === 0) this.events.onTurnStart?.(turn);
          this.started = seq;
          for (const fn of this.attached.get(seq) ?? []) fn();
          this.attached.delete(seq);
          if (text.trim()) this.said.push(text.trim());
          this.events.onText?.(this.said.join(' '), seq === this.finalSeq);
        },
        onEnd: () => {
          if (turn !== this.current || seq !== this.finalSeq) return;
          this.events.onText?.(this.said.join(' '), true);
          this.current = undefined;
          this.events.onTurnEnd?.(turn);
        },
      });
    }
  }

  private attach(seq: number, fn: () => void) {
    if (seq <= this.started) return fn();
    const list = this.attached.get(seq) ?? [];
    list.push(fn);
    this.attached.set(seq, list);
  }

  private reset() {
    this.pending.clear();
    this.attached.clear();
    this.next = 0;
    this.finalSeq = undefined;
    this.started = -1;
    this.said = [];
  }
}
