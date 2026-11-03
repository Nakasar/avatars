/**
 * Web socket d'une application (avatar) Breign : le canal descendant. La plateforme y pousse
 * tout ce que l'avatar doit dire, montrer ou faire (`SAY`, `SHOW_IMAGE`, `DO_ACTION`…).
 *
 * Protocole (doc Breign « Réception : le protocole WebSocket ») :
 *  - `wss://…/apps/{appId}/sockets`, ou `…/apps/{appId}/instances/{instanceId}/sockets` ;
 *  - le serveur demande `REQUEST_AUTHENTICATION`, le client répond `AUTHENTICATION_RESPONSE`
 *    avec le `authSecret` de l'app (ou le jeton d'une instance éphémère) et `version: 2` ;
 *  - après `AUTHENTICATION_SUCCESS`, la socket reçoit les commandes ;
 *  - `PING` toutes les 25 s (socket morte sans `PONG` sous 10 s) ;
 *  - reconnexion exponentielle (1 s → 30 s) avec rejeu depuis le dernier `websocketMessageId`,
 *    mais jamais après `DISCONNECT`, `AUTHENTICATION_FAILED` ou `ERROR`.
 */

export interface AudioRef {
  type?: string;
  src: string;
  id?: string;
}

export interface AppMessage {
  type: string;
  websocketMessageId?: string;
  timestamp?: string;
  replayed?: boolean;
  messageId?: string;
  conversationId?: string;
  sequence?: number;
  text?: string;
  raw?: string;
  final?: boolean;
  lang?: string;
  audio?: AudioRef;
  image?: { title?: string; src: string };
  action?: { code: string; type?: string; [key: string]: unknown };
  suggestions?: Array<{ id: string; text: string }>;
  hasFillers?: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export type SocketState = 'connecting' | 'authenticating' | 'ready' | 'closed' | 'failed';

export interface AppSocketOptions {
  /** URL complète de la socket (`wss://…/sockets`). */
  url: string;
  /** Secret de l'app, ou jeton de l'instance éphémère. Peut changer (renouvellement). */
  authSecret: () => string | Promise<string>;
  onMessage: (m: AppMessage) => void;
  onState?: (s: SocketState, detail?: string) => void;
}

/** Messages trop vieux pour être joués après un rejeu (une réponse d'il y a dix minutes…). */
const STALE_MS = 45_000;

export class AppSocket {
  private ws?: WebSocket;
  private retry = 1000;
  private retryTimer?: number;
  private pingTimer?: number;
  private pongTimer?: number;
  private stopped = false;
  private lastId?: string;
  state: SocketState = 'closed';

  constructor(private opts: AppSocketOptions) {}

  get ready() {
    return this.state === 'ready';
  }

  connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.stopped = true;
      this.setState('failed', `URL de socket invalide : ${this.opts.url}`);
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m: AppMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return console.debug('[socket] message non JSON', ev.data);
      }
      void this.onMessage(ws, m);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.stopTimers();
      if (this.stopped) {
        if (this.state !== 'failed') this.setState('closed');
        return;
      }
      this.setState('connecting');
      this.retryTimer = window.setTimeout(() => this.connect(), this.retry + Math.random() * 500);
      this.retry = Math.min(this.retry * 2, 30_000);
    };
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.stopTimers();
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.setState('closed');
  }

  private send(ws: WebSocket, m: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  private async onMessage(ws: WebSocket, m: AppMessage) {
    if (m.websocketMessageId) this.lastId = m.websocketMessageId;
    switch (m.type) {
      case 'REQUEST_AUTHENTICATION': {
        this.setState('authenticating');
        if (m.isAlreadyConnected) console.warn('[socket] une autre fenêtre utilise déjà cette instance : elle va être déconnectée');
        let authSecret: string;
        try {
          authSecret = await this.opts.authSecret();
        } catch (e) {
          return this.fail(`Secret de l’application introuvable : ${e instanceof Error ? e.message : e}`);
        }
        this.send(ws, { type: 'AUTHENTICATION_RESPONSE', authSecret, version: 2 });
        return;
      }
      case 'AUTHENTICATION_SUCCESS':
        this.retry = 1000;
        this.setState('ready');
        this.startPing(ws);
        // Récupère ce qui a été envoyé pendant une coupure.
        if (this.lastId) this.send(ws, { type: 'REPLAY_MESSAGES', fromWebSocketMessageId: this.lastId });
        return;
      case 'AUTHENTICATION_FAILED':
        return this.fail('Authentification de la socket refusée : secret de l’app ou jeton d’instance invalide.');
      case 'ERROR':
        return this.fail(`Socket Breign : ${m.code ?? 'erreur'}${m.message ? ` (${m.message})` : ''}`);
      case 'DISCONNECT':
        // Une autre socket a pris la place : surtout ne pas se reconnecter (sinon ping-pong).
        return this.fail('Cette instance a été ouverte ailleurs (autre onglet ou appareil) : avatar déconnecté.');
      case 'PONG':
        clearTimeout(this.pongTimer);
        return;
      case 'PING':
        this.send(ws, { type: 'PONG' });
        return;
      case 'REPLAY_MESSAGES_COMPLETED':
        if (m.replayedMessagesCount) console.info('[socket] messages rejoués :', m.replayedMessagesCount);
        return;
      case 'REPLAY_MESSAGES_ERROR':
        console.warn('[socket] rejeu impossible', m.code);
        return;
    }
    if (m.replayed && m.timestamp && Date.now() - Date.parse(m.timestamp) > STALE_MS) return;
    this.opts.onMessage(m);
  }

  private fail(detail: string) {
    this.stopped = true;
    this.setState('failed', detail);
    this.ws?.close();
  }

  private startPing(ws: WebSocket) {
    this.stopTimers();
    this.pingTimer = window.setInterval(() => {
      this.send(ws, { type: 'PING' });
      clearTimeout(this.pongTimer);
      // Pas de réponse : la socket est morte, on la ferme pour relancer la reconnexion.
      this.pongTimer = window.setTimeout(() => ws.close(), 10_000);
    }, 25_000);
  }

  private stopTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  private setState(s: SocketState, detail?: string) {
    this.state = s;
    this.opts.onState?.(s, detail);
  }
}

/**
 * URL de la socket à partir de l'URL de l'API : `https://api.breign.eu` → `wss://api.breign.eu`,
 * et un chemin relatif (`/breign-api`, proxy de développement) → la même origine en `ws(s)://`.
 * Hors de la machine locale, un chemin relatif donne VITE_BREIGN_SOCKET_URL (par défaut wss://api.breign.eu).
 */
export function appSocketUrl(basePath: string, appId: string, instanceId?: string) {
  const base = basePath.replace(/\/$/, '');
  const abs = /^https?:\/\//i.test(base)
    ? base.replace(/^http/i, 'ws')
    : isLoopback()
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base.startsWith('/') ? '' : '/'}${base}`
      : // Hébergé (Vercel…) : les réécritures ne relaient pas les web sockets, on va droit à l'API.
        (import.meta.env.VITE_BREIGN_SOCKET_URL || 'wss://api.breign.eu').replace(/\/$/, '');
  const inst = instanceId && instanceId !== 'DEFAULT' ? `/instances/${encodeURIComponent(instanceId)}` : '';
  return `${abs}/apps/${encodeURIComponent(appId)}${inst}/sockets`;
}

function isLoopback() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}
