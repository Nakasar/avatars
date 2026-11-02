import { AuthApi, Configuration, UsersApi } from '@breign/client';

/**
 * Connexion « Se connecter avec Breign », sur le modèle de `breign login` (CLI) :
 * OAuth2 code d'autorisation + PKCE, avec retour sur une adresse loopback (RFC 8252).
 *
 *   1. `GET /auth/authorize?client_id=…&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=…`
 *      redirige vers l'écran de consentement de Breign App ;
 *   2. Breign App renvoie le navigateur sur `/callback?code=…&state=…` ;
 *   3. `POST /auth/token` échange le code (+ le vérificateur PKCE) contre une clé API de
 *      l'utilisateur, nommée d'après `device_name`.
 *
 * Rien n'est à saisir : la clé obtenue est rangée dans ce navigateur, comme l'était la clé
 * collée à la main.
 */

/** Client OAuth Breign. Par défaut celui de la CLI, déjà connu de la plateforme. */
export const OAUTH_CLIENT_ID: string = import.meta.env.VITE_BREIGN_OAUTH_CLIENT_ID || 'breign-cli';
export const CALLBACK_PATH = '/callback';

const PENDING_KEY = 'breign-avatar:oauth-pending';

export interface BreignAccount {
  keyId: string;
  keyName: string;
  email?: string | null;
  userId?: string;
}

export interface BreignLogin extends BreignAccount {
  apiKey: string;
}

interface Pending {
  state: string;
  verifier: string;
  basePath: string;
  redirectUri: string;
  returnTo: string;
}

/**
 * Comme la CLI, le retour se fait sur `127.0.0.1` (RFC 8252 §8.3 préfère l'IP à `localhost`).
 * Depuis `localhost`, on bascule d'abord sur `127.0.0.1` (même port), puis la connexion reprend.
 */
export function needsLoopbackIp() {
  return location.hostname === 'localhost' || location.hostname === '[::1]';
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
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = `${location.protocol}//${location.host}${CALLBACK_PATH}`;
  const pending: Pending = {
    state,
    verifier,
    basePath,
    redirectUri,
    returnTo: location.pathname === CALLBACK_PATH ? '/' : location.pathname + location.search,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  // `basePath` peut être relatif (`/breign-api`, le proxy de dev) : la redirection 302 de
  // l'API vers Breign App traverse alors le proxy, sans souci.
  const url = new URL(`${apiBase(basePath)}/auth/authorize`, location.href);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    device_name: deviceName(),
  }).toString();
  location.assign(url);
}

/**
 * Au chargement de la page : si l'on revient de Breign App (`/callback`), échange le code
 * contre la clé API. Renvoie `null` hors retour de connexion.
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

  const auth = new AuthApi(new Configuration({ basePath: apiBase(pending.basePath) }));
  const res = await auth.exchangeApplicationAuthorizationCodeRaw({
    applicationTokenRequestUio: {
      grantType: 'authorization_code',
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      clientId: OAUTH_CLIENT_ID,
    },
  });
  // Lecture brute pour garder `user_id`, renvoyé par l'API mais absent du schéma.
  const body = await res.raw.json();
  return {
    apiKey: body.access_token,
    keyId: body.key_id,
    keyName: body.key_name,
    email: body.email,
    userId: body.user_id,
  };
}

/** Déconnexion : révoque la clé créée par la connexion, si possible, puis l'oublie. */
export async function revokeLogin(basePath: string, apiKey: string, account?: BreignAccount) {
  if (!account?.userId || !account.keyId) return;
  try {
    const users = new UsersApi(new Configuration({ basePath: apiBase(basePath), apiKey }));
    await users.deleteUserApiKey(account.userId, account.keyId);
  } catch (e) {
    console.warn('[breign] révocation de la clé impossible, elle reste visible dans votre profil', e);
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
