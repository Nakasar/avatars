/**
 * Actions natives de Breign : en plus de son texte, un message de l'agent peut porter des
 * actions (`actions: [{ code, … }]`), directement ou dans les résultats de ses outils
 * (`toolResults[].result.actions`). Les applications distantes Breign s'en servent pour
 * montrer une image ou ouvrir une page web à côté de l'avatar.
 *
 * Le SDK ne type que `code` ; le reste dépend de l'action. La lecture est donc tolérante :
 * le code est normalisé (`SHOW_IMAGE`, `show-image`, `showImage` → `SHOWIMAGE`) et l'URL est
 * cherchée sous les noms usuels, y compris dans un sous-objet (`params`, `data`…).
 */

export type NativeActionKind = 'image' | 'video' | 'url' | 'unknown';

export interface NativeAction {
  /** Code tel qu'envoyé par Breign. */
  code: string;
  kind: NativeActionKind;
  url?: string;
  title?: string;
  /** Objet d'origine, pour le débogage. */
  raw: Record<string, unknown>;
}

const KINDS: Array<[NativeActionKind, RegExp]> = [
  ['image', /IMAGE|PICTURE|PHOTO|IMG/],
  ['video', /VIDEO|MOVIE/],
  ['url', /URL|LINK|WEBVIEW|WEB|PAGE|BROWSER|IFRAME|OPEN/],
];

const URL_KEYS = ['url', 'src', 'imageUrl', 'image_url', 'image', 'videoUrl', 'href', 'link', 'uri', 'source', 'value'];
const TITLE_KEYS = ['title', 'alt', 'caption', 'label', 'name', 'description', 'text'];

/** Toutes les actions d'un message Breign (actions du message et de ses outils), sans doublon. */
export function collectNativeActions(message: unknown): NativeAction[] {
  const m = (message ?? {}) as Record<string, unknown>;
  const list: unknown[] = [];
  if (Array.isArray(m.actions)) list.push(...m.actions);
  if (Array.isArray(m.toolResults)) {
    for (const r of m.toolResults as Array<{ result?: { actions?: unknown[] } }>) {
      if (Array.isArray(r?.result?.actions)) list.push(...r.result.actions);
    }
  }
  const seen = new Set<string>();
  const out: NativeAction[] = [];
  for (const a of list) {
    const action = toNativeAction(a);
    if (!action) continue;
    const key = `${action.code}|${action.url ?? JSON.stringify(action.raw)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

export function toNativeAction(a: unknown): NativeAction | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const raw = a as Record<string, unknown>;
  const code = String(raw.code ?? raw.type ?? raw.action ?? '');
  if (!code) return undefined;
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const url = findString(raw, URL_KEYS, looksLikeUrl);
  const title = findString(raw, TITLE_KEYS, (s) => !looksLikeUrl(s) && s !== code);
  let kind: NativeActionKind = KINDS.find(([, re]) => re.test(norm))?.[0] ?? 'unknown';
  // Une URL d'image ou de vidéo se reconnaît aussi à son extension.
  if (url && (kind === 'url' || kind === 'unknown')) {
    if (/\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(url) || url.startsWith('data:image/')) kind = 'image';
    else if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) kind = 'video';
    else if (kind === 'unknown') kind = 'url';
  }
  return { code, kind, url, title, raw };
}

function looksLikeUrl(s: string) {
  return /^(https?:\/\/|\/|data:(image|video)\/|blob:)/i.test(s.trim());
}

/** Première chaîne trouvée sous l'un des noms, au premier niveau puis dans les sous-objets. */
function findString(
  o: Record<string, unknown>,
  keys: string[],
  accept: (s: string) => boolean,
  depth = 0,
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() && accept(v)) return v.trim();
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
      const inner = findString(v as Record<string, unknown>, keys, accept, depth + 1);
      if (inner) return inner;
    }
  }
  if (depth >= 2) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (keys.includes(k) || k === 'code') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = findString(v as Record<string, unknown>, keys, accept, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}
