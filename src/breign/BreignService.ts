import {
  AgentApi,
  AppApi,
  AppStatusUio,
  Configuration,
  PromptsApi,
  ResponseError,
  type AgentUio,
} from '@breign/client';
import { collectNativeActions, type NativeAction } from './nativeActions';
import { breignConfig, isSignedIn } from './oauth';

export interface BreignSettings {
  /** URL de l'API. En dev, `/breign-api` passe par le proxy Vite vers https://api.breign.eu. */
  basePath: string;
  apiKey: string;
  agentId: string;
  /** Application (avatar) Breign : active la voix (TTS) et la transcription configurées. */
  appId?: string;
  /**
   * Instance de l'application : chaque appareil ou onglet qui affiche l'avatar a la sienne
   * (une seule socket par instance). Vide : l'instance par défaut de l'app.
   */
  instanceId?: string;
  lang: string;
}

export interface ReplyProgress {
  /** Texte de la réponse déjà généré (cumulatif). */
  text: string;
  status: string;
  done: boolean;
}

const TERMINAL = new Set(['completed', 'failed', 'moderated']);

/**
 * Accès à la plateforme Breign via le SDK `@breign/client`.
 *
 * Le dialogue reprend le fonctionnement de la CLI `breign chat` : envoi du message en mode
 * asynchrone (`?async=true`), puis lecture du statut du message de réponse, dont le contenu
 * grandit pendant la génération (`generating` → `completed`). On peut ainsi faire parler
 * l'avatar phrase par phrase, sans attendre la fin de la réponse.
 */
export class BreignService {
  private prompts: PromptsApi;
  private agents: AgentApi;
  private apps: AppApi;
  conversationId?: string;
  /** Conversation menée par l'application (réponses reçues sur la web socket). */
  appConversationId?: string;
  private authSecret?: Promise<string>;

  constructor(readonly settings: BreignSettings) {
    // Clé API (X-API-Key) ou session OAuth (Authorization: Bearer, renouvelée au besoin).
    const config = new Configuration(breignConfig(settings));
    this.prompts = new PromptsApi(config);
    this.agents = new AgentApi(config);
    this.apps = new AppApi(config);
  }

  get configured() {
    return Boolean(isSignedIn(this.settings) && this.settings.agentId);
  }

  resetConversation() {
    this.conversationId = undefined;
    this.appConversationId = undefined;
  }

  private get instance() {
    const id = this.settings.instanceId?.trim();
    return id && id !== 'DEFAULT' ? id : undefined;
  }

  /**
   * Secret de l'application, pour authentifier sa web socket. Il est lu dans la liste des
   * apps de l'agent (`GET /agents/{agentId}/apps`) avec le compte connecté : il ne quitte
   * jamais la mémoire de la page.
   */
  appAuthSecret(): Promise<string> {
    this.authSecret ??= (async () => {
      const { appId, agentId } = this.settings;
      const apps = await this.apps.getAppsForAgentId(agentId);
      const app = apps.find((a) => a.id === appId);
      if (!app) throw new Error('Application introuvable parmi celles de l’agent : vérifiez l’agent et l’application dans les réglages.');
      return app.authSecret;
    })();
    this.authSecret.catch(() => (this.authSecret = undefined));
    return this.authSecret;
  }

  /**
   * Envoie un message par l'application : la requête rend la main tout de suite, la réponse
   * arrive sur la web socket (`INPUT`, `SAY`…) avec le `messageId` renvoyé ici.
   */
  async askApp(message: string): Promise<string | undefined> {
    const { appId, lang } = this.settings;
    if (!appId) throw new Error('Aucune application Breign configurée.');
    if (this.appConversationId) {
      const res = await this.apps.submitNewMessageToChat(appId, this.appConversationId, { message, lang }, this.instance);
      const r = res as unknown as { conversationId?: string; messageId?: string };
      if (r.conversationId) this.appConversationId = r.conversationId;
      return r.messageId;
    }
    const res = await this.apps.createAppChat(appId, { message, lang }, this.instance);
    this.appConversationId = res.conversationId;
    return res.messageId;
  }

  /** Prévient Breign que l'avatar s'est tu (l'utilisateur lui a coupé la parole). */
  async interruptApp() {
    if (!this.settings.appId) return;
    await this.apps.interruptApp(this.settings.appId, this.instance);
  }

  /** Fin de réponse : seul le client sait quand il a fini de parler. */
  async setAppIdle() {
    if (!this.settings.appId) return;
    await this.apps.setStatus(this.settings.appId, { status: AppStatusUio.Idle }, this.instance);
  }

  async listAgents(): Promise<AgentUio[]> {
    return this.agents.getAgents(undefined, undefined, 1, 100);
  }

  async getAgent(): Promise<AgentUio> {
    return this.agents.getAgentById(this.settings.agentId);
  }

  /**
   * Envoie un message à l'agent et suit la génération de la réponse.
   * `onProgress` est appelé à chaque évolution du texte ; `onActions` reçoit, une fois la
   * réponse terminée, ses actions natives (montrer une image, ouvrir une page…).
   */
  async send(
    message: string,
    onProgress: (p: ReplyProgress) => void,
    signal?: AbortSignal,
    onActions?: (actions: NativeAction[]) => void,
  ): Promise<string> {
    const { agentId, lang } = this.settings;
    const res = this.conversationId
      ? await this.prompts.sendMessageToConversation(
          this.conversationId,
          { message, stream: true, lang },
          true,
        )
      : await this.prompts.createPrompt(agentId, { message, lang, stream: true }, true);
    this.conversationId = res.conversationId;

    // Réponse synchrone (serveur sans mode asynchrone) : le texte est déjà là.
    if (res.text) {
      onProgress({ text: res.text, status: 'completed', done: true });
      if (onActions) void this.fetchActions(res.conversationId, res.messageId, signal).then(onActions);
      return res.text;
    }

    let last = '';
    let delay = 250;
    for (;;) {
      if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      await sleep(delay);
      const st = await this.prompts.getMessageStatus(res.conversationId, res.messageId);
      const text = st.content ?? '';
      const done = TERMINAL.has(st.status);
      if (text !== last || done) {
        last = text;
        onProgress({ text, status: st.status, done });
        delay = 250;
      } else {
        delay = Math.min(delay * 1.4, 1200);
      }
      if (st.status === 'failed') {
        throw new Error(st.error?.message ?? 'La génération de la réponse a échoué.');
      }
      if (st.status === 'moderated') {
        return text || 'Ce message a été bloqué par les règles de l’organisation.';
      }
      if (done) {
        if (onActions) void this.fetchActions(res.conversationId, res.messageId, signal).then(onActions);
        return text;
      }
    }
  }

  /**
   * Actions natives d'un message (le statut de génération ne les porte pas : il faut relire
   * le message une fois terminé). Ne lève jamais : sans actions, renvoie une liste vide.
   */
  async fetchActions(conversationId: string, messageId: string, signal?: AbortSignal): Promise<NativeAction[]> {
    try {
      const msg = await this.prompts.getMessageById(conversationId, messageId, { signal });
      const actions = collectNativeActions(msg);
      if (actions.length) console.info('[breign] actions natives :', actions.map((a) => a.raw));
      return actions;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn('[breign] actions du message illisibles', e);
      return [];
    }
  }

  /** Synthèse vocale avec la voix de l'application Breign. Renvoie l'URL de l'audio. */
  async textToSpeech(text: string): Promise<string | null> {
    if (!this.settings.appId) return null;
    const res = await this.apps.textToSpeech(this.settings.appId, { text, permanent: false });
    return res.audio.src;
  }

  /** Transcription d'un enregistrement WAV (configuration de l'application, sinon de l'agent). */
  async speechToText(wav: Blob): Promise<string> {
    const { appId, agentId, lang } = this.settings;
    const res = appId
      ? await this.apps.convertAppSpeechToText(appId, wav, lang)
      : await this.agents.convertAgentSpeechToText(agentId, wav, lang);
    return res.transcription;
  }
}

/** Message d'erreur lisible à partir d'une erreur du SDK. */
export async function describeError(e: unknown): Promise<string> {
  if (e instanceof ResponseError) {
    const status = e.response.status;
    let detail = '';
    try {
      const body = await e.response.clone().json();
      detail = body?.message ?? body?.error_description ?? body?.error ?? '';
    } catch {
      /* corps non JSON */
    }
    if (status === 401) return 'Session Breign expirée ou clé révoquée (401). Reconnectez-vous dans les réglages (⚙).';
    if (status === 403) return `Accès refusé (403)${detail ? ` : ${detail}` : ''}.`;
    if (status === 400) return `Requête refusée par Breign${detail ? ` : ${detail}` : ''}.`;
    if (status === 404) return `Ressource introuvable (404)${detail ? ` : ${detail}` : ''}. Vérifiez l’agent ou l’application.`;
    return `Erreur ${status}${detail ? ` : ${detail}` : ''}`;
  }
  if (e instanceof TypeError) {
    return 'Impossible de joindre l’API Breign (réseau ou CORS). En local, utilisez le proxy /breign-api.';
  }
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
