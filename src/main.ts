import * as THREE from 'three';
import { Stage } from './scene/Stage';
import { Avatar } from './avatar/Avatar';
import type { Character } from './avatar/Character';
import { Orb, ORB_PALETTES } from './orb/Orb';
import { Voice } from './avatar/Voice';
import { BreignService, describeError, type BreignSettings } from './breign/BreignService';
import { Conversation, type ConversationState } from './conversation/Conversation';
import { loadSettings, saveSettings, type AppSettings } from './settings';
import { completeLogin, credentialTag, isSignedIn, revokeLogin, startLogin } from './breign/oauth';
import { parseActions } from './actions/parse';
import { actionPrompt, allActionCodes, type ActionCode } from './actions/vocabulary';
import type { Expression } from './avatar/Avatar';
import type { NativeAction } from './breign/nativeActions';
import { AppSocket, appSocketUrl, type AppMessage, type SocketState } from './breign/AppSocket';
import { resolveAction } from './actions/vocabulary';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage($('stage'), {
  quality: (new URLSearchParams(location.search).get('quality') as 'high' | 'medium' | 'low') ?? 'high',
});

let settings: AppSettings = loadSettings();
let breign = new BreignService(settings);
const voice = new Voice((text) => breign.textToSpeech(text), settings.lang);
let avatar: Character | undefined;
const DEFAULT_MODEL = '/models/human.glb';

// ---------------------------------------------------------------- Apparence (humain ou orbe)
let shown = '';
let loadToken = 0;

/** Affiche l'apparence demandée ; ne recharge que si elle change vraiment. */
async function showCharacter(s: Pick<AppSettings, 'appearance' | 'orbColor' | 'modelUrl'>) {
  const key = s.appearance === 'orb' ? 'orb' : `human:${s.modelUrl || DEFAULT_MODEL}`;
  if (key === shown) {
    if (avatar instanceof Orb) {
      avatar.setColor(s.orbColor);
      stage.setLook('holo', ORB_PALETTES[s.orbColor].main);
    }
    return;
  }
  shown = key;
  const token = ++loadToken;
  $('loading').classList.toggle('hidden', s.appearance === 'orb');
  try {
    const next: Character =
      s.appearance === 'orb' ? new Orb(s.orbColor) : await Avatar.load(s.modelUrl || DEFAULT_MODEL, stage.renderer);
    if (token !== loadToken) return next.dispose?.(); // une autre apparence a été choisie entre-temps
    const mode = avatar?.currentMode ?? 'idle';
    if (avatar) {
      stage.scene.remove(avatar.root);
      avatar.dispose?.();
    }
    avatar = next;
    stage.scene.add(avatar.root);
    stage.setLook(s.appearance === 'orb' ? 'holo' : 'studio', ORB_PALETTES[s.orbColor].main);
    stage.frame(avatar.root, avatar.root.localToWorld(avatar.focus.clone()), avatar.framingHeight);
    avatar.setMode(mode);
    avatar.setExpression('listening', 0.6);
    if (avatar instanceof Avatar) {
      console.info('[avatar] blendshapes :', avatar.morphTargetNames.length, avatar.morphTargetNames);
    }
  } catch (e) {
    shown = '';
    showError(`Impossible de charger le modèle 3D : ${e instanceof Error ? e.message : e}`);
  } finally {
    if (token === loadToken) $('loading').classList.add('hidden');
  }
}

stage.onUpdate((dt, t) => {
  if (!avatar) return;
  const { visemes, energy } = voice.sample(dt);
  avatar.setVisemes(visemes, voice.speaking ? energy : 0);
  avatar.lookAt(stage.camera.position);
  avatar.update(dt, t);
});

// ---------------------------------------------------------------- Codes d'action de l'agent
/** Pour l'humain, qui n'a ni couleur ni forme : seules les émotions proches sont jouées. */
const HUMAN_EXPRESSIONS: Record<string, [Expression, number]> = {
  NEUTRAL: ['neutral', 1], HAPPY: ['happy', 0.9], PROUD: ['happy', 0.5], LOVING: ['happy', 0.6],
  SAD: ['sad', 0.8], AFRAID: ['surprised', 0.5], SURPRISED: ['surprised', 0.9],
  CURIOUS: ['thinking', 0.5], CONFUSED: ['thinking', 0.8], CALM: ['neutral', 1], AGGRESSIVE: ['neutral', 1],
};

function applyAction(code: ActionCode) {
  if (!avatar) return;
  if (avatar.applyAction?.(code)) return;
  if (code.category === 'EMOTION' && HUMAN_EXPRESSIONS[code.value]) {
    const [name, k] = HUMAN_EXPRESSIONS[code.value];
    avatar.setExpression(name, k * (code.param ? parseFloat(code.param) || 1 : 1));
  } else if (code.category === 'FX' && (code.value === 'NOD' || code.value === 'PULSE')) avatar.nod();
  else if (code.category === 'RESET') avatar.setExpression('neutral', 1);
  else console.info('[actions] code non joué par cette apparence :', code.raw);
}
voice.onCue = applyAction;

/** Joue tout de suite les codes d'un texte (champ de test des réglages, console). */
function testActions(text: string) {
  const { cues, unknown } = parseActions(text.includes('[') ? text : `[${text}]`);
  for (const c of cues) applyAction(c.code);
  if (unknown.length) showError(`Code inconnu : ${unknown.join(' ')}`);
  return cues.length;
}

// ---------------------------------------------------------------- Actions natives de Breign
const media = $('media');
const mediaBody = $('media-body');

/** Montre une image, une vidéo ou une page web envoyée par l'agent (action native Breign). */
function showMedia(a: Pick<NativeAction, 'kind' | 'url' | 'title'>) {
  if (!a.url) return false;
  mediaBody.replaceChildren();
  let el: HTMLElement;
  if (a.kind === 'image') {
    const img = new Image();
    img.src = a.url;
    img.alt = a.title ?? '';
    img.onerror = () => showError('Impossible d’afficher l’image envoyée par l’agent.');
    el = img;
  } else if (a.kind === 'video') {
    const v = document.createElement('video');
    Object.assign(v, { src: a.url, controls: true, autoplay: true, muted: true, playsInline: true, loop: true });
    el = v;
  } else {
    // Beaucoup de sites refusent d'être intégrés : le lien ↗ reste là pour les ouvrir à part.
    const f = document.createElement('iframe');
    f.src = a.url;
    f.title = a.title ?? 'Page envoyée par l’agent';
    f.referrerPolicy = 'no-referrer';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    el = f;
  }
  mediaBody.append(el);
  media.dataset.kind = a.kind;
  $('media-title').textContent = a.title ?? '';
  $<HTMLAnchorElement>('media-open').href = a.url;
  media.hidden = false;
  requestAnimationFrame(() => media.classList.add('visible'));
  // L'orbe accompagne l'apparition d'un petit geste.
  avatar?.applyAction?.({ raw: '', category: 'FX', value: 'PULSE' });
  return true;
}

function hideMedia() {
  media.classList.remove('visible');
  setTimeout(() => {
    if (media.classList.contains('visible')) return;
    media.hidden = true;
    mediaBody.replaceChildren(); // arrête une vidéo ou une page en cours
  }, 300);
}
$('media-close').addEventListener('click', hideMedia);

function handleNativeActions(actions: NativeAction[]) {
  // Plusieurs médias : le dernier l'emporte (un seul panneau à la fois).
  const shown = [...actions].reverse().find((a) => a.kind !== 'unknown' && a.url);
  if (shown) showMedia(shown);
  for (const a of actions) {
    if (a !== shown) console.info('[breign] action native non gérée :', a.code, a.raw);
  }
}

/** `DO_ACTION` de Breign : balise d'action de la réponse (`[ACTION.EMOTION.HAPPY]`) ou outil. */
function handleAppAction(a: NonNullable<AppMessage['action']>) {
  const code = resolveAction(a.code);
  if (code) return applyAction(code);
  const type = String(a.type ?? '').toUpperCase();
  if (type === 'PLAY_ANIMATION') {
    // Une animation au nom d'un effet ou d'une émotion de l'orbe (« pulse », « happy »…) est jouée.
    const id = String(a.animationId ?? '');
    const as = resolveAction(`FX.${id}`) ?? resolveAction(`EMOTION.${id}`);
    if (as) return applyAction(as);
  }
  if (type === 'APP_SHOW_PAGE' && typeof a.url === 'string') {
    return void showMedia({ kind: 'url', url: pageUrl(a.url, a.query), title: a.code });
  }
  console.info('[breign] action non gérée :', a.code, a);
}

/** Complète les paramètres demandés par `APP_SHOW_PAGE` (`query: { conversationId: true }`). */
function pageUrl(url: string, query: unknown) {
  const u = new URL(url, location.href);
  const known: Record<string, string | undefined> = {
    conversationId: breign.appConversationId,
    appId: settings.appId,
    agentId: settings.agentId,
    instanceId: settings.instanceId,
    lang: settings.lang,
  };
  for (const [k, v] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    // La clé API n'est jamais transmise à une page tierce.
    if (v === true && known[k]) u.searchParams.set(k, known[k]!);
    else if (typeof v === 'string' || typeof v === 'number') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// Relances proposées en fin de réponse : un clic les envoie comme message suivant.
const suggestionBox = $('suggestions');
function showSuggestions(list: Array<{ id: string; text: string }>) {
  suggestionBox.replaceChildren(
    ...list.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.text;
      b.onclick = () => {
        suggestionBox.replaceChildren();
        void begin().then(() => conversation.sendText(s.text));
      };
      return b;
    }),
  );
}

// Web socket de l'application : la plateforme y pousse les réponses de l'avatar (SAY avec
// la voix déjà synthétisée, SHOW_IMAGE, DO_ACTION…). Tant qu'elle n'est pas prête, la
// conversation passe par l'API des agents.
let socket: AppSocket | undefined;
let socketKey = '';
const SOCKET_LABEL: Record<SocketState, string> = {
  connecting: 'Connexion à la web socket…',
  authenticating: 'Authentification de la web socket…',
  ready: 'Web socket connectée ✓',
  closed: '',
  failed: 'Web socket indisponible : réponses par l’API des agents.',
};
function connectSocket() {
  const { appId, agentId, basePath, instanceId } = settings;
  const cred = credentialTag(settings);
  const key = appId && agentId && cred ? [basePath, appId, instanceId, agentId, cred].join('|') : '';
  if (key === socketKey) return;
  socket?.close();
  socket = undefined;
  socketKey = key;
  conversation.appMode = false;
  $('socket-status').textContent = '';
  if (!key) return;
  const s = new AppSocket({
    url: appSocketUrl(basePath, appId!, instanceId),
    authSecret: () => breign.appAuthSecret(),
    onMessage: (m) => conversation.onAppMessage(m),
    onState: (state, detail) => {
      if (s !== socket) return;
      conversation.appMode = state === 'ready';
      $('socket-status').textContent = SOCKET_LABEL[state];
      if (detail) showError(detail);
    },
  });
  socket = s;
  s.connect();
}
window.addEventListener('pagehide', () => socket?.close());

/** Joue un message comme s'il venait de la web socket : appSocketMessage({ type: 'SHOW_IMAGE', … }). */
const appSocketMessage = (m: AppMessage) => conversation.onAppMessage(m);

// ---------------------------------------------------------------- Conversation
const STATE_LABEL: Record<ConversationState, string> = {
  off: 'Touchez l’écran pour commencer',
  idle: 'Je vous écoute',
  'user-speaking': 'Je vous écoute…',
  transcribing: 'Je réfléchis…',
  thinking: 'Je réfléchis…',
  speaking: 'Vous pouvez m’interrompre',
};

const conversation = new Conversation(voice, () => breign, () => avatar, {
  onState: (s) => {
    document.body.dataset.state = s;
    $('hint').textContent = STATE_LABEL[s];
  },
  onUserText: (text) => caption('user', text),
  onAgentText: (text) => caption('agent', text || '…'),
  onError: (msg) => showError(msg),
  onLevel: (level) => $('orb').style.setProperty('--level', level.toFixed(3)),
  onNativeActions: handleNativeActions,
  onReplyStart: () => {
    hideMedia();
    suggestionBox.replaceChildren();
  },
  onAppAction: handleAppAction,
  onSuggestions: showSuggestions,
});

function caption(kind: 'user' | 'agent', text: string) {
  const el = $(kind === 'user' ? 'caption-user' : 'caption-agent');
  el.textContent = text;
  el.classList.add('visible');
  if (kind === 'user') $('caption-agent').classList.remove('visible');
}

let errorTimer: number | undefined;
function showError(msg: string) {
  const el = $('error');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => el.classList.remove('visible'), 7000);
}

// Démarrage au premier geste : les navigateurs exigent une interaction pour le micro et le son.
async function begin() {
  if (conversation.current !== 'off') return;
  if (!isSignedIn(settings)) {
    // Pas encore connecté : la page part vers Breign, puis revient ici, connectée.
    void login();
    return;
  }
  try {
    await conversation.start();
    $('start').classList.add('hidden');
    if (!breign.configured) openSettings('Choisissez l’agent qui vous répondra.');
  } catch (e) {
    showError(`Micro indisponible : ${e instanceof Error ? e.message : e}`);
  }
}
$('start').addEventListener('click', begin);

// Clavier (facultatif) : « / » ouvre la saisie, Entrée envoie, Échap coupe l'avatar.
const typeBox = $<HTMLFormElement>('type-box');
const typeInput = $<HTMLInputElement>('type-input');
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('dialog, input')) {
    if (e.key === 'Escape' && e.target === typeInput) typeBox.classList.remove('visible');
    return;
  }
  if (e.key === 'Escape') conversation.interrupt();
  if (e.key === '/') {
    e.preventDefault();
    typeBox.classList.add('visible');
    typeInput.focus();
  }
});
typeBox.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = typeInput.value.trim();
  typeInput.value = '';
  typeBox.classList.remove('visible');
  if (!text) return;
  void begin().then(() => conversation.sendText(text));
});

// ---------------------------------------------------------------- Réglages
const dialog = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('settings-form');

function fillForm() {
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'object') continue;
    const el = form.elements.namedItem(k) as HTMLInputElement | null;
    if (el) el.value = v ?? '';
  }
  form.dataset.look = settings.appearance;
}

// Aperçu en direct : l'apparence et la couleur changent dès qu'on les choisit.
form.addEventListener('change', (e) => {
  const name = (e.target as HTMLInputElement).name;
  if (name !== 'appearance' && name !== 'orbColor') return;
  const draft = readForm();
  form.dataset.look = draft.appearance;
  void showCharacter({ ...draft, modelUrl: settings.modelUrl });
});
function readForm(): AppSettings {
  const data = new FormData(form);
  return {
    ...settings,
    ...(Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v).trim()])) as Partial<AppSettings>),
  };
}

function openSettings(message?: string) {
  fillForm();
  renderAccount();
  conversation.vad.paused = true;
  if (!dialog.open) dialog.showModal();
  if (message) showError(message);
}

$('settings-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openSettings();
});

// ---------------------------------------------------------------- Connexion Breign (OAuth2)
function renderAccount() {
  const signedIn = isSignedIn(settings);
  $('account-out').hidden = signedIn;
  $('account-in').hidden = !signedIn;
  $('account-name').textContent = settings.account
    ? settings.account.email || settings.account.keyName
    : 'Clé API personnelle';
  // La clé manuelle reste possible, repliée par défaut.
  $<HTMLDetailsElement>('api-key-box').open = signedIn && !settings.account;
  $('start-title').textContent = signedIn ? 'Commencer la conversation' : 'Se connecter avec Breign';
  $('start-sub').textContent = signedIn
    ? 'Autorisez le micro, puis parlez naturellement. Vous pouvez couper la parole à l’avatar à tout moment.'
    : 'Connectez-vous à votre compte Breign, puis parlez naturellement à l’avatar.';
}

async function login() {
  // Les réglages en cours d'édition sont gardés pour le retour.
  if (dialog.open) settings = { ...readForm(), apiKey: settings.apiKey };
  saveSettings(settings);
  try {
    await startLogin(settings.basePath);
  } catch (e) {
    showError(await describeError(e));
  }
}

$('login').addEventListener('click', () => void login());
$('logout').addEventListener('click', async () => {
  await revokeLogin(settings.basePath, settings.apiKey, settings.account);
  settings = { ...settings, apiKey: '', account: undefined };
  (form.elements.namedItem('apiKey') as HTMLInputElement).value = '';
  saveSettings(settings);
  renderAccount();
  void applySettings();
});

dialog.addEventListener('close', () => {
  conversation.vad.paused = false;
  if (dialog.returnValue !== 'save') return void showCharacter(settings); // annule l'aperçu
  const next = readForm();
  // Une clé changée à la main n'est plus celle du compte connecté.
  if (next.apiKey !== settings.apiKey) next.account = undefined;
  settings = next;
  saveSettings(settings);
  renderAccount();
  void applySettings();
  void showCharacter(settings);
});

$('load-agents').addEventListener('click', async () => {
  const draft = new BreignService(readForm() as BreignSettings);
  const list = $<HTMLSelectElement>('agent-list');
  try {
    const agents = await draft.listAgents();
    list.innerHTML = '<option value="">— choisir un agent —</option>';
    for (const a of agents) list.add(new Option(a.name, a.id));
    list.hidden = false;
  } catch (e) {
    alert(await describeError(e));
  }
});
$<HTMLSelectElement>('agent-list').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v) (form.elements.namedItem('agentId') as HTMLInputElement).value = v;
});

$('demo').addEventListener('click', () => {
  voice.unlock();
  conversation.interrupt();
  avatar?.resetActions?.();
  voice.lang = (form.elements.namedItem('lang') as HTMLSelectElement).value;
  avatar?.setMode('speaking');
  avatar?.setExpression('happy', 0.5);
  voice.say(
    voice.lang === 'fr'
      ? '[ACTION.EMOTION.HAPPY] Bonjour ! Je suis votre avatar Breign. [ACTION.FX.PULSE] Parlez-moi simplement, je vous écoute, et vous pouvez me couper la parole quand vous voulez.'
      : '[ACTION.EMOTION.HAPPY] Hello! I am your Breign avatar. [ACTION.FX.PULSE] Just talk to me, I am listening, and feel free to interrupt me at any time.',
  );
});

async function applySettings() {
  breign = new BreignService(settings);
  voice.lang = settings.lang;
  connectSocket();
  if (!breign.configured) {
    $('agent-name').textContent = '';
    return;
  }
  try {
    const agent = await breign.getAgent();
    $('agent-name').textContent = agent.name;
  } catch (e) {
    showError(await describeError(e));
  }
}

// ---------------------------------------------------------------- Démarrage
document.body.dataset.state = 'off';
void showCharacter(settings);

async function boot() {
  try {
    const signedIn = await completeLogin();
    if (signedIn) {
      const { apiKey, ...account } = signedIn;
      settings = { ...loadSettings(), apiKey, account };
      saveSettings(settings);
    }
  } catch (e) {
    showError(await describeError(e));
  }
  renderAccount();
  const q = new URLSearchParams(location.search);
  if (q.get('login') === '1') {
    // Reprise après la bascule localhost → 127.0.0.1.
    q.delete('login');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
    if (!isSignedIn(settings)) return void login();
  }
  await applySettings();
  if (isSignedIn(settings) && !settings.agentId) {
    openSettings('Connecté à Breign. Choisissez maintenant l’agent qui vous répondra.');
    $('load-agents').click();
  }
}
void boot();

// ---------------------------------------------------------------- Test des codes d'action
const codeList = $<HTMLDataListElement>('action-codes');
for (const c of allActionCodes()) codeList.append(new Option(c));
const codeInput = $<HTMLInputElement>('action-test');
$('action-run').addEventListener('click', () => {
  if (codeInput.value.trim()) testActions(codeInput.value);
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (codeInput.value.trim()) testActions(codeInput.value);
});
$('action-reset').addEventListener('click', () => testActions('[ACTION.RESET]'));
$('action-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(actionPrompt());
    btn.textContent = 'Consignes copiées ✓';
  } catch {
    showError('Copie impossible : les consignes sont dans docs/codes-action.md.');
  }
  setTimeout(() => (btn.textContent = 'Copier les consignes pour l’agent'), 2500);
});

// Accès console pour le débogage : actions('[ACTION.EMOTION.AGGRESSIVE]').
// showMedia({ kind: 'image', url: '…', title: '…' }) montre un média comme le ferait l'agent.
Object.assign(window, { stage, voice, conversation, THREE, actions: testActions, actionPrompt, showMedia, handleNativeActions, appSocketMessage });
Object.defineProperty(window, 'avatar', { get: () => avatar });
