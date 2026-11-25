/**
 * Transcription en flux de Breign : un WebSocket où l'on streame l'audio (PCM16 mono) et d'où
 * reviennent les transcriptions, provisoires puis définitives.
 *
 * Protocole (doc « Realtime transcription » et OpenAPI de `@breign/client`) :
 *  - une requête HTTP ouvre la session et renvoie `{ wsUrl, ticket, mode, model }` : l'URL est
 *    relative à l'endpoint WebSocket de l'API, le ticket ne sert qu'une fois (dans les 60 s) ;
 *  - premier message, sous 5 s : `{"type":"auth","ticket":"…"}` ;
 *  - le serveur répond `session.ready { mode, model, audio: { encoding: 'pcm16', sampleRate } }`,
 *    l'audio envoyé avant est ignoré ;
 *  - trames binaires PCM16 little-endian mono au `sampleRate` annoncé, ~100 ms chacune ;
 *  - `{"type":"commit"}` clôt le segment sans attendre le silence, `{"type":"stop"}` termine
 *    proprement (derniers segments transcrits, puis `session.closed`) ;
 *  - retours : `transcript.partial { itemId, text }` (mode `native` seulement),
 *    `transcript.final { itemId, text, startMs, endMs }`, `usage`, `error { code, message, fatal }`,
 *    `session.closed { reason }`, et selon la session `avatar.turn` / `avatar.turn_failed`.
 *
 * Une coupure (réseau, `SESSION_EXPIRED`, fin des 4 h) rouvre une **nouvelle** session via
 * `open()` (le ticket est à usage unique), avec un délai croissant.
 */

export interface TranscriptionSessionInfo {
  wsUrl: string;
  ticket: string;
  mode?: string;
  model?: string;
}

export interface TranscriptFrame {
  type: string;
  itemId?: string;
  text?: string;
  startMs?: number;
  endMs?: number;
  code?: string;
  message?: string;
  fatal?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export type StreamState = 'connecting' | 'ready' | 'closed' | 'failed';

export interface TranscriptionStreamOptions {
  /** URL de l'API (`https://api.breign.eu` ou `/breign-api` en dev) : sert à composer `wss://…`. */
  basePath: string;
  /**
   * Ouvre une session (appelée à la connexion et à chaque reconnexion). `attempt` vaut 0 la
   * première fois : la réunion, par exemple, rouvre ensuite via un autre endpoint.
   */
  open: (attempt: number) => Promise<TranscriptionSessionInfo>;
  onPartial?: (itemId: string, text: string) => void;
  onFinal?: (f: TranscriptFrame) => void;
  /** Toute autre trame du serveur (`avatar.turn`, `usage`…). */
  onFrame?: (f: TranscriptFrame) => void;
  onState?: (s: StreamState, detail?: string) => void;
}

/** Erreurs après lesquelles réessayer ne sert à rien. */
const PERMANENT = new Set(['AUTH_FAILED', 'LIMIT_EXCEEDED', 'MODEL_UNSUPPORTED']);
/** Taille cible d'une trame audio envoyée. */
const FRAME_MS = 100;
/** Audio gardé en attendant `session.ready` (la première phrase n'est pas perdue). */
const MAX_BACKLOG_MS = 4000;

export class TranscriptionStream {
  private ws?: WebSocket;
  private stopped = true;
  private attempt = 0;
  private retry = 1000;
  private retryTimer?: number;
  private sampleRate = 16000;
  /** Échantillons au débit de la session, pas encore envoyés. */
  private out: number[] = [];
  /** Position fractionnaire du rééchantillonneur (entre deux appels). */
  private resamplePos = 0;
  private lastInput = 0;
  state: StreamState = 'closed';
  mode?: string;
  model?: string;

  constructor(private opts: TranscriptionStreamOptions) {}

  get ready() {
    return this.state === 'ready';
  }

  /** Ouvre la session et le WebSocket. Rejette si la première ouverture HTTP échoue. */
  async connect() {
    this.stopped = false;
    this.attempt = 0;
    await this.openSocket();
  }

  /**
   * Envoie de l'audio (Float32 mono, au débit de l'`AudioContext`). Il est rééchantillonné au
   * débit de la session et découpé en trames de ~100 ms. Avant `session.ready`, il est gardé
   * (quelques secondes au plus).
   */
  pushAudio(samples: Float32Array, inputRate: number) {
    if (this.stopped) return;
    const ratio = inputRate / this.sampleRate;
    // Rééchantillonnage linéaire, continu d'un appel à l'autre : l'index -1 désigne le dernier
    // échantillon de l'appel précédent.
    const prev = this.lastInput;
    const at = (k: number) => (k < 0 ? prev : samples[k]);
    let pos = this.resamplePos;
    while (Math.floor(pos) + 1 < samples.length) {
      const i = Math.floor(pos);
      const a = at(i);
      this.out.push(a + (samples[i + 1] - a) * (pos - i));
      pos += ratio;
    }
    this.resamplePos = pos - samples.length;
    if (samples.length) this.lastInput = samples[samples.length - 1];

    const frame = Math.round((this.sampleRate * FRAME_MS) / 1000);
    if (!this.ready) {
      const max = Math.round((this.sampleRate * MAX_BACKLOG_MS) / 1000);
      if (this.out.length > max) this.out.splice(0, this.out.length - max);
      return;
    }
    while (this.out.length >= frame) this.sendPcm(this.out.splice(0, frame));
  }

  /** Envoie du silence (garde la session vivante sans transmettre la pièce). */
  pushSilence(ms: number, inputRate: number) {
    this.pushAudio(new Float32Array(Math.round((inputRate * ms) / 1000)), inputRate);
  }

  /** Clôt le segment en cours sans attendre le silence (envoie d'abord l'audio restant). */
  commit() {
    if (!this.ready) return;
    this.flush();
    this.send({ type: 'commit' });
  }

  /** Oublie l'audio en attente (ex. bruit bref annulé avant d'être envoyé). */
  drop() {
    this.out = [];
  }

  /** Fin propre : derniers segments transcrits, puis fermeture par le serveur. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    if (ws && this.ready) {
      this.flush();
      this.send({ type: 'stop' });
      // Le serveur ferme après `session.closed` ; on ne l'attend pas plus de quelques secondes.
      window.setTimeout(() => ws.close(), 5000);
    } else {
      ws?.close();
    }
    this.ws = undefined;
    this.out = [];
    this.setState('closed');
  }

  /** Fermeture immédiate, sans attendre les derniers segments. */
  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.out = [];
    this.setState('closed');
  }

  private async openSocket() {
    this.setState('connecting');
    const info = await this.opts.open(this.attempt++);
    if (this.stopped) return;
    this.mode = info.mode;
    this.model = info.model;
    const ws = new WebSocket(transcriptionSocketUrl(this.opts.basePath, info.wsUrl));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket: info.ticket }));
    ws.onmessage = (ev) => {
      if (ws !== this.ws || typeof ev.data !== 'string') return;
      let f: TranscriptFrame;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onFrame(f);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      this.scheduleReconnect();
    };
  }

  private onFrame(f: TranscriptFrame) {
    switch (f.type) {
      case 'session.ready': {
        const audio = f.audio as { sampleRate?: number } | undefined;
        const rate = Number(audio?.sampleRate) || 16000;
        if (rate !== this.sampleRate) {
          // L'audio gardé était au mauvais débit : on le jette plutôt que de le déformer.
          this.out = [];
          this.sampleRate = rate;
        }
        if (typeof f.mode === 'string') this.mode = f.mode;
        if (typeof f.model === 'string') this.model = f.model;
        this.retry = 1000;
        this.setState('ready');
        this.flushFrames();
        return;
      }
      case 'transcript.partial':
        this.opts.onPartial?.(f.itemId ?? '', f.text ?? '');
        return;
      case 'transcript.final':
        this.opts.onFinal?.(f);
        return;
      case 'error':
        if (f.fatal || PERMANENT.has(f.code ?? '')) {
          if (PERMANENT.has(f.code ?? '')) return this.fail(describeStreamError(f));
          // Erreur fatale passagère (fournisseur, session expirée) : nouvelle session.
          console.warn('[transcription]', f.code, f.message);
          this.ws?.close();
          return;
        }
        console.warn('[transcription]', f.code, f.message);
        this.opts.onFrame?.(f);
        return;
      case 'session.closed':
        // Fin voulue (`stop`) ou imposée (durée max) : onclose relancera si on n'a pas fini.
        if (this.stopped) this.ws?.close();
        return;
    }
    this.opts.onFrame?.(f);
  }

  private scheduleReconnect() {
    this.setState('connecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.openSocket().catch((e) => {
        console.warn('[transcription] réouverture impossible', e);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, this.retry + Math.random() * 500);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  private fail(detail: string) {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = undefined;
    this.setState('failed', detail);
  }

  private flushFrames() {
    const frame = Math.round((this.sampleRate * FRAME_MS) / 1000);
    while (this.out.length >= frame) this.sendPcm(this.out.splice(0, frame));
  }

  private flush() {
    this.flushFrames();
    if (this.out.length) this.sendPcm(this.out.splice(0));
  }

  private sendPcm(samples: number[]) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(toPcm16(samples));
  }

  private send(m: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private setState(s: StreamState, detail?: string) {
    if (s === this.state && !detail) return;
    this.state = s;
    this.opts.onState?.(s, detail);
  }
}

/** Float [-1, 1] → PCM16 little-endian. */
export function toPcm16(samples: ArrayLike<number>): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const v = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function describeStreamError(f: TranscriptFrame) {
  switch (f.code) {
    case 'AUTH_FAILED':
      return 'Transcription en direct refusée (ticket invalide ou expiré).';
    case 'LIMIT_EXCEEDED':
      return 'Transcription en direct coupée : limite ou budget de l’organisation atteint.';
    case 'MODEL_UNSUPPORTED':
      return 'Le modèle de transcription configuré ne sait pas transcrire en flux.';
    default:
      return `Transcription en direct : ${f.code ?? 'erreur'}${f.message ? ` (${f.message})` : ''}`;
  }
}

/**
 * URL du WebSocket de transcription : `wsUrl` (ex. `/ws/transcription/…`) est relatif à
 * l'endpoint WebSocket de l'API. Une URL absolue est gardée telle quelle.
 */
export function transcriptionSocketUrl(basePath: string, wsUrl: string) {
  if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
  if (/^https?:\/\//i.test(wsUrl)) return wsUrl.replace(/^http/i, 'ws');
  return `${socketBase(basePath)}${wsUrl.startsWith('/') ? '' : '/'}${wsUrl}`;
}

/**
 * Base `ws(s)://` de l'API : `https://api.breign.eu` → `wss://api.breign.eu`, et un chemin
 * relatif (`/breign-api`, proxy de développement) → la même origine. Hors de la machine locale,
 * un chemin relatif donne VITE_BREIGN_SOCKET_URL (par défaut wss://api.breign.eu), car les
 * réécritures de Vercel ne relaient pas les WebSockets.
 */
export function socketBase(basePath: string) {
  const base = basePath.replace(/\/$/, '');
  if (/^https?:\/\//i.test(base)) return base.replace(/^http/i, 'ws');
  if (isLoopback()) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base.startsWith('/') ? '' : '/'}${base}`;
  }
  return (import.meta.env.VITE_BREIGN_SOCKET_URL || 'wss://api.breign.eu').replace(/\/$/, '');
}

function isLoopback() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}
