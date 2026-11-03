import { AuthApi, Configuration, UsersApi, type ConfigurationParameters } from '@breign/client';

/**
 * « Se connecter avec Breign » : deux flux, selon le client OAuth utilisé.
 *
 * **Client d'organisation** (`VITE_BREIGN_OAUTH_CLIENT_ID`, client public déclaré dans l'écran
 * Applications de Breign) : fournisseur OAuth 2.1 / OpenID Connect de Breign.
 *   1. `GET {API}/rp/auth/oauth2/authorize?…&scope=openid profile email offline_access breign&resource={API}`
 *      (PKCE S256, `redirect_uri` HTTPS déclaré dans les `redirectUris` du client) ;
 *   2. retour sur `/callback?code=…&state=…` ;
 *   3. `POST {API}/rp/auth/oauth2/token` (`resource` obligatoire, pas de secret) : `access_token`
 *      JWT d'une heure, passé en `Authorization: Bearer`, et `refresh_token` rotatif de 30 jours.
 *
 * **Sans client d'organisation** : le flux des applications de bureau de Breign (`breign login`),
 * réservé au client `breign-cli` et aux retours loopback (RFC 8252), donc au développement local.
 *   `GET /auth/authorize` puis `POST /auth/token`, qui renvoie une clé API de l'utilisateur.
 */

/** Client OAuth d'organisation. Vide : le client de la CLI, en local seulement. */
const ORG_CLIENT_ID: string = import.meta.env.VITE_BREIGN_OAUTH_CLIENT_ID || '';
const DESKTOP_CLIENT_ID = 'breign-cli';
export const OAUTH_CLIENT_ID = ORG_CLIENT_ID || DESKTOP_CLIENT_ID;
/** Scopes du fournisseur OIDC ; `breign` est nécessaire pour appeler l'API. */
const OIDC_SCOPE = 'openid profile email offline_access breign';
export const CALLBACK_PATH = '/callback';

const PENDING_KEY = 'breign-avatar:oauth-pending';
const SESSION_KEY = 'breign-avatar:oidc-session';

export interface BreignAccount {
  keyId?: string;
  keyName: string;
  email?: string | null;
  userId?: string;
  /** `oidc` : session OAuth (jeton Bearer) ; sinon clé API. */
  kind?: 'oidc' | 'key';
}

export interface BreignLogin extends BreignAccount {
  /** Clé API (flux de bureau). Vide pour une session OIDC, gardée à part. */
  apiKey: string;
}

interface Pending {
  flow: 'oidc' | 'desktop';
  state: string;
  verifier: string;
  basePath: string;
  redirectUri: string;
  returnTo: string;
}

/** Session OAuth OIDC, rangée dans ce navigateur (hors des réglages). */
interface OidcSession {
  accessToken: string;
  refreshToken?: string;
  /** Expiration du jeton d'accès (ms depuis l'epoch). */
  expiresAt: number;
  basePath: string;
  resource: string;
}

/**
 * Valeur du paramètre `resource` (obligatoire) : l'URL de l'API, telle qu'indiquée dans
 * l'encadré Intégration de l'écran Applications de Breign.
 */
function oidcResource(basePath: string) {
  const env = import.meta.env.VITE_BREIGN_OAUTH_RESOURCE;
  if (env) return env.replace(/\/$/, '');
  const base = apiBase(basePath);
  return /^https?:\/\//i.test(base) ? base : 'https://api.breign.eu';
}

/**
 * Comme la CLI, le retour se fait sur `127.0.0.1` (RFC 8252 §8.3 préfère l'IP à `localhost`).
 * Depuis `localhost`, on bascule d'abord sur `127.0.0.1` (même port), puis la connexion reprend.
 */
export function needsLoopbackIp() {
  return !ORG_CLIENT_ID && (location.hostname === 'localhost' || location.hostname === '[::1]');
}

/** Lance la connexion : le navigateur quitte la page pour l'écran de consentement Breign. */
export async function startLogin(basePath: string) {
  if (needsLoopbackIp()) {
    const url = new URL(location.href);
    url.hostname = '127.0.0.1';
    url.searchParams.set('login', '1');
    location.replace(url);
    return;
  }
  const flow: Pending['flow'] = ORG_CLIENT_ID ? 'oidc' : 'desktop';
  if (flow === 'desktop' && location.hostname !== '127.0.0.1') {
    // Le client de la CLI n'accepte que les retours loopback : Breign répondrait
    // « Invalid authorization request » sur une page JSON. On prévient plutôt ici.
    throw new Error(
      'Connexion Breign indisponible sur ce site : il faut un client OAuth d’organisation déclaré pour ' +
        `${location.origin}${CALLBACK_PATH} (VITE_BREIGN_OAUTH_CLIENT_ID). En attendant, utilisez une clé API dans les réglages.`,
    );
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = `${location.protocol}//${location.host}${CALLBACK_PATH}`;
  const pending: Pending = {
    flow,
    state,
    verifier,
    basePath,
    redirectUri,
    returnTo: location.pathname === CALLBACK_PATH ? '/' : location.pathname + location.search,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  // `basePath` peut être relatif (`/breign-api`, le proxy) : la redirection 302 de l'API vers
  // l'écran de consentement traverse alors le proxy, sans souci.
  const common = {
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  };
  const url =
    flow === 'oidc'
      ? new URL(`${apiBase(basePath)}/rp/auth/oauth2/authorize`, location.href)
      : new URL(`${apiBase(basePath)}/auth/authorize`, location.href);
  url.search = new URLSearchParams(
    flow === 'oidc'
      ? { ...common, scope: OIDC_SCOPE, resource: oidcResource(basePath) }
      : { ...common, device_name: deviceName() },
  ).toString();
  location.assign(url);
}

/**
 * Au chargement de la page : si l'on revient de Breign (`/callback`), échange le code contre
 * une clé API (flux de bureau) ou une session OIDC. Renvoie `null` hors retour de connexion.
 */
export async function completeLogin(): Promise<BreignLogin | null> {
  if (location.pathname !== CALLBACK_PATH) return null;
  const q = new URLSearchParams(location.search);
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
  } catch {
    /* rien */
  }
  sessionStorage.removeItem(PENDING_KEY);
  // On efface aussitôt le code de la barre d'adresse et de l'historique.
  history.replaceState(null, '', pending?.returnTo ?? '/');

  const error = q.get('error');
  if (error) {
    throw new Error(
      error === 'access_denied'
        ? 'Connexion refusée dans Breign.'
        : `Connexion Breign impossible : ${q.get('error_description') || error}`,
    );
  }
  const code = q.get('code');
  if (!code || !pending) throw new Error('Connexion Breign interrompue, recommencez.');
  if (q.get('state') !== pending.state) throw new Error('Connexion Breign refusée : état invalide.');

  if (pending.flow === 'oidc') {
    const resource = oidcResource(pending.basePath);
    const body = await tokenRequest(pending.basePath, {
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      resource,
    });
    saveSession(toSession(body, pending.basePath, resource));
    const claims = jwtClaims(body.id_token) ?? jwtClaims(body.access_token) ?? {};
    return {
      apiKey: '',
      kind: 'oidc',
      keyName: claims.name || 'Compte Breign',
      email: claims.email,
      userId: claims.sub,
    };
  }

  const auth = new AuthApi(new Configuration({ basePath: apiBase(pending.basePath) }));
  const res = await auth.exchangeApplicationAuthorizationCodeRaw({
    applicationTokenRequestUio: {
      grantType: 'authorization_code',
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      clientId: DESKTOP_CLIENT_ID,
    },
  });
  // Lecture brute pour garder `user_id`, renvoyé par l'API mais absent du schéma.
  const body = await res.raw.json();
  return {
    apiKey: body.access_token,
    kind: 'key',
    keyId: body.key_id,
    keyName: body.key_name,
    email: body.email,
    userId: body.user_id,
  };
}

/** Connecté : clé API (collée ou obtenue par le flux de bureau) ou session OIDC. */
export function isSignedIn(s: { apiKey: string }) {
  return Boolean(s.apiKey) || loadSession() !== null;
}

/** Identifie l'identifiant en cours (pour savoir s'il faut rouvrir la web socket). */
export function credentialTag(s: { apiKey: string }) {
  if (s.apiKey) return s.apiKey;
  const session = loadSession();
  // Stable pendant la session : le renouvellement du jeton ne doit pas rouvrir la socket.
  return session ? `oidc:${session.basePath}` : '';
}

/**
 * Paramètres du SDK selon l'identifiant : la clé API (en-tête `X-API-Key`) l'emporte ; sinon
 * le jeton OIDC en `Authorization: Bearer`, renouvelé avant son expiration.
 */
export function breignConfig(s: { basePath: string; apiKey: string }): ConfigurationParameters {
  const basePath = apiBase(s.basePath);
  if (s.apiKey || !loadSession()) return { basePath, apiKey: s.apiKey };
  return {
    basePath,
    middleware: [
      {
        pre: async (ctx) => {
          const token = await accessToken();
          if (!token) return ctx;
          const headers = new Headers(ctx.init.headers);
          headers.set('Authorization', `Bearer ${token}`);
          return { url: ctx.url, init: { ...ctx.init, headers } };
        },
      },
    ],
  };
}

let refreshing: Promise<OidcSession | null> | null = null;

/** Jeton d'accès valide (renouvelé une minute avant son expiration), ou `null`. */
export async function accessToken(): Promise<string | null> {
  let session = loadSession();
  if (!session) return null;
  if (session.expiresAt - 60_000 < Date.now()) {
    if (!session.refreshToken) return session.accessToken; // l'API répondra 401 : reconnexion
    // Un seul renouvellement à la fois : le refresh_token est rotatif (usage unique).
    refreshing ??= refresh(session).finally(() => (refreshing = null));
    session = await refreshing;
  }
  return session?.accessToken ?? null;
}

async function refresh(session: OidcSession): Promise<OidcSession | null> {
  try {
    const body = await tokenRequest(session.basePath, {
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: session.refreshToken!,
      resource: session.resource,
    });
    const next = toSession(body, session.basePath, session.resource, session.refreshToken);
    saveSession(next);
    return next;
  } catch (e) {
    console.warn('[breign] renouvellement de la session impossible, reconnectez-vous', e);
    clearSession();
    return null;
  }
}

async function tokenRequest(basePath: string, params: Record<string, string>) {
  const res = await fetch(new URL(`${apiBase(basePath)}/rp/auth/oauth2/token`, location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Connexion Breign impossible : ${body.error_description || body.error || `erreur ${res.status}`}`,
    );
  }
  return body as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string };
}

function toSession(
  body: { access_token: string; refresh_token?: string; expires_in?: number },
  basePath: string,
  resource: string,
  previousRefresh?: string,
): OidcSession {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    basePath,
    resource,
  };
}

function loadSession(): OidcSession | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function saveSession(s: OidcSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible */
  }
}

/**
 * Déconnexion : oublie la session OIDC, ou révoque la clé créée par le flux de bureau si
 * possible, puis l'oublie.
 */
export async function revokeLogin(basePath: string, apiKey: string, account?: BreignAccount) {
  clearSession();
  if (!apiKey || !account?.userId || !account.keyId) return;
  try {
    const users = new UsersApi(new Configuration({ basePath: apiBase(basePath), apiKey }));
    await users.deleteUserApiKey(account.userId, account.keyId);
  } catch (e) {
    console.warn('[breign] révocation de la clé impossible, elle reste visible dans votre profil', e);
  }
}

function jwtClaims(token?: string): { sub?: string; email?: string; name?: string } | null {
  try {
    const part = token?.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

function apiBase(basePath: string) {
  return basePath.replace(/\/$/, '');
}

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'navigateur';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `Breign Avatars (${browser}${os ? `, ${os}` : ''})`;
}

function base64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
