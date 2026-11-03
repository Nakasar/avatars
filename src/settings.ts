import type { BreignSettings } from './breign/BreignService';
import type { BreignAccount } from './breign/oauth';
import type { Appearance } from './avatar/Character';
import { isOrbColor, type OrbColor } from './orb/Orb';

export interface AppSettings extends BreignSettings {
  modelUrl: string;
  /** Apparence du bot : humain 3D ou orbe IA. */
  appearance: Appearance;
  /** Couleur de l'orbe. */
  orbColor: OrbColor;
  /** Compte obtenu par « Se connecter avec Breign » (absent pour une clé collée à la main). */
  account?: BreignAccount;
}

const KEY = 'breign-avatar:settings';

/**
 * Réglages : valeurs par défaut (variables VITE_*), puis celles enregistrées dans ce navigateur,
 * puis les paramètres d'URL (`?agent=…&app=…&lang=…&model=…&look=orb&color=violet`), qui l'emportent.
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
    appearance: env.VITE_AVATAR_APPEARANCE === 'orb' ? 'orb' : 'human',
    orbColor: isOrbColor(env.VITE_AVATAR_ORB_COLOR) ? env.VITE_AVATAR_ORB_COLOR : 'blue',
    instanceId: env.VITE_BREIGN_INSTANCE_ID || '',
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
  if (q.get('instance')) fromUrl.instanceId = q.get('instance')!;
  if (q.get('lang')) fromUrl.lang = q.get('lang')!;
  if (q.get('model')) fromUrl.modelUrl = q.get('model')!;
  if (q.get('look') === 'orb' || q.get('look') === 'human') fromUrl.appearance = q.get('look') as Appearance;
  if (isOrbColor(q.get('color'))) fromUrl.orbColor = q.get('color') as OrbColor;
  const clean = (o: Partial<AppSettings>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  const merged = { ...defaults, ...clean(stored), ...clean(fromUrl) } as AppSettings;
  if (merged.appearance !== 'orb') merged.appearance = 'human';
  if (!isOrbColor(merged.orbColor)) merged.orbColor = 'blue';
  return merged;
}

export function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}
