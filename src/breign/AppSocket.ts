import { toNativeAction, type NativeAction } from './nativeActions';

/**
 * Message reçu sur la web socket d'une application (avatar) Breign. La plateforme y pousse
 * ce que l'avatar doit faire : `SAY` (dire un texte), `SHOW_IMAGE` (montrer une image)…
 *
 * ```json
 * { "type": "SHOW_IMAGE", "messageId": "…", "sequence": 0, "text": "An image",
 *   "image": { "title": "An image", "src": "https://…" } }
 * ```
 */
export interface AppSocketMessage {
  type: string;
  messageId?: string;
  sequence?: number;
  text?: string;
  [key: string]: unknown;
}

export interface AppSocketEvents {
  /** Action native à jouer (image, vidéo, page web…). */
  onAction?: (action: NativeAction, message: AppSocketMessage) => void;
  /** Texte à dire (`SAY`) : ignoré par défaut, la réponse étant déjà suivie par l'API. */
  onSay?: (message: AppSocketMessage) => void;
  onStatus?: (connected: boolean) => void;
}

/**
 * Connexion à la web socket de l'application, avec reconnexion automatique.
 * L'URL est donnée telle quelle par les réglages ; `{appId}` et `{apiKey}` y sont remplacés.
 */
export class AppSocket {
  private ws?: WebSocket;
  private retry = 0;
  private timer?: number;
  private closed = false;
  /** Messages déjà joués (une même action peut arriver deux fois après une reconnexion). */
  private seen = new Set<string>();

  constructor(
    private url: string,
    private events: AppSocketEvents = {},
  ) {}

  connect() {
    this.closed = false;
    clearTimeout(this.timer);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      console.warn('[breign] web socket : URL invalide', this.url, e);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.events.onStatus?.(true);
      console.info('[breign] web socket connectée');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        this.handle(JSON.parse(ev.data));
      } catch {
        console.debug('[breign] web socket : message non JSON', ev.data);
      }
    };
    ws.onclose = () => {
      this.events.onStatus?.(false);
      if (this.closed) return;
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = undefined;
  }

  /** Traite un message de la plateforme (exposé pour les essais depuis la console). */
  handle(data: unknown) {
    // Le message peut arriver nu ou enveloppé (`{ "message": { … } }`, comme dans l'API REST).
    const raw = (data as { message?: unknown })?.message ?? data;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const m of list as AppSocketMessage[]) {
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') continue;
      const key = `${m.messageId ?? ''}|${m.sequence ?? ''}|${m.type}`;
      if (m.messageId && this.seen.has(key)) continue;
      if (m.messageId) this.seen.add(key);
      const type = m.type.toUpperCase();
      if (type === 'SAY') {
        this.events.onSay?.(m);
        continue;
      }
      if (type === 'INPUT') continue; // écho du message de l'utilisateur
      const action = toNativeAction(m);
      if (action) this.events.onAction?.(action, m);
    }
  }
}

export function socketUrl(template: string, vars: { appId?: string; apiKey?: string }) {
  return template
    .replace(/\{appId\}/g, encodeURIComponent(vars.appId ?? ''))
    .replace(/\{apiKey\}/g, encodeURIComponent(vars.apiKey ?? ''));
}
