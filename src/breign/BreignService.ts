import {
  AgentApi,
  AppApi,
  Configuration,
  PromptsApi,
  ResponseError,
  type AgentUio,
} from '@breign/client';

export interface BreignSettings {
  /** URL de l'API. En dev, `/breign-api` passe par le proxy Vite vers https://api.breign.eu. */
  basePath: string;
  apiKey: string;
  agentId: string;
  /** Application (avatar) Breign : active la voix (TTS) et la transcription configurées. */
  appId?: string;
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

  constructor(readonly settings: BreignSettings) {
    const config = new Configuration({
      basePath: settings.basePath.replace(/\/$/, ''),
      apiKey: settings.apiKey,
    });
    this.prompts = new PromptsApi(config);
    this.agents = new AgentApi(config);
    this.apps = new AppApi(config);
  }

  get configured() {
    return Boolean(this.settings.apiKey && this.settings.agentId);
  }

  resetConversation() {
    this.conversationId = undefined;
  }

  async listAgents(): Promise<AgentUio[]> {
    return this.agents.getAgents(undefined, undefined, 1, 100);
  }

  async getAgent(): Promise<AgentUio> {
    return this.agents.getAgentById(this.settings.agentId);
  }

  /**
   * Envoie un message à l'agent et suit la génération de la réponse.
   * `onProgress` est appelé à chaque évolution du texte.
   */
  async send(
    message: string,
    onProgress: (p: ReplyProgress) => void,
    signal?: AbortSignal,
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
      if (done) return text;
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
      detail = body?.message ?? body?.error ?? '';
    } catch {
      /* corps non JSON */
    }
    if (status === 401) return 'Clé API refusée (401). Vérifiez la clé dans les réglages.';
    if (status === 403) return `Accès refusé (403)${detail ? ` : ${detail}` : ''}.`;
    if (status === 404) return `Ressource introuvable (404)${detail ? ` : ${detail}` : ''}. Vérifiez l’agent ou l’application.`;
    return `Erreur ${status}${detail ? ` : ${detail}` : ''}`;
  }
  if (e instanceof TypeError) {
    return 'Impossible de joindre l’API Breign (réseau ou CORS). En local, utilisez le proxy /breign-api.';
  }
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
