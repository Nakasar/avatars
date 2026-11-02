import type { BreignSettings } from './breign/BreignService';
import type { BreignAccount } from './breign/oauth';

export interface AppSettings extends BreignSettings {
  modelUrl: string;
  /** Compte obtenu par « Se connecter avec Breign » (absent pour une clé collée à la main). */
  account?: BreignAccount;
}

const KEY = 'breign-avatar:settings';

/**
 * Réglages : valeurs par défaut (variables VITE_*), puis celles enregistrées dans ce navigateur,
 * puis les paramètres d'URL (`?agent=…&app=…&lang=…&model=…`), qui l'emportent.
 * La clé API n'est jamais lue depuis l'URL, pour éviter qu'elle ne fuite dans un lien partagé.
 */
export function loadSettings(): AppSettings {
  const env = import.meta.env;
  const defaults: AppSettings = {
    basePath: env.VITE_BREIGN_API_URL || '/breign-api',
    apiKey: env.VITE_BREIGN_API_KEY || '',
    agentId: env.VITE_BREIGN_AGENT_ID || '',
    appId: env.VITE_BREIGN_APP_ID || '',
    lang: env.VITE_BREIGN_LANG || 'fr',
    modelUrl: env.VITE_AVATAR_MODEL_URL || '',
  };
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    /* stockage indisponible */
  }
  const q = new URLSearchParams(location.search);
  const fromUrl: Partial<AppSettings> = {};
  if (q.get('agent')) fromUrl.agentId = q.get('agent')!;
  if (q.get('app')) fromUrl.appId = q.get('app')!;
  if (q.get('lang')) fromUrl.lang = q.get('lang')!;
  if (q.get('model')) fromUrl.modelUrl = q.get('model')!;
  const clean = (o: Partial<AppSettings>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  return { ...defaults, ...clean(stored), ...clean(fromUrl) };
}

export function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}
