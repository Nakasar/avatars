import * as THREE from 'three';
import { Stage } from './scene/Stage';
import { Avatar } from './avatar/Avatar';
import { Voice } from './avatar/Voice';
import { BreignService, describeError, type BreignSettings } from './breign/BreignService';
import { Conversation, type ConversationState } from './conversation/Conversation';
import { loadSettings, saveSettings, type AppSettings } from './settings';
import { completeLogin, revokeLogin, startLogin } from './breign/oauth';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage($('stage'), {
  quality: (new URLSearchParams(location.search).get('quality') as 'high' | 'medium' | 'low') ?? 'high',
});

let settings: AppSettings = loadSettings();
let breign = new BreignService(settings);
const voice = new Voice((text) => breign.textToSpeech(text), settings.lang);
let avatar: Avatar | undefined;
const DEFAULT_MODEL = '/models/human.glb';

// ---------------------------------------------------------------- Avatar
async function loadAvatar(url: string) {
  $('loading').classList.remove('hidden');
  try {
    const next = await Avatar.load(url, stage.renderer);
    if (avatar) stage.scene.remove(avatar.root);
    avatar = next;
    stage.scene.add(avatar.root);
    stage.frame(avatar.root, avatar.root.localToWorld(avatar.focus.clone()), avatar.framingHeight);
    avatar.setExpression('listening', 0.6);
    console.info('[avatar] blendshapes :', avatar.morphTargetNames.length, avatar.morphTargetNames);
  } catch (e) {
    showError(`Impossible de charger le modèle 3D : ${e instanceof Error ? e.message : e}`);
  } finally {
    $('loading').classList.add('hidden');
  }
}

stage.onUpdate((dt, t) => {
  if (!avatar) return;
  const { visemes, energy } = voice.sample(dt);
  avatar.setVisemes(visemes, voice.speaking ? energy : 0);
  avatar.lookAt(stage.camera.position);
  avatar.update(dt, t);
});

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
  if (!settings.apiKey) {
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
    const el = form.elements.namedItem(k) as HTMLInputElement | null;
    if (el) el.value = v ?? '';
  }
}
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
  const signedIn = Boolean(settings.apiKey);
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
  if (dialog.returnValue !== 'save') return;
  const prevModel = settings.modelUrl;
  const next = readForm();
  // Une clé changée à la main n'est plus celle du compte connecté.
  if (next.apiKey !== settings.apiKey) next.account = undefined;
  settings = next;
  saveSettings(settings);
  renderAccount();
  void applySettings();
  if (settings.modelUrl !== prevModel) void loadAvatar(settings.modelUrl || DEFAULT_MODEL);
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
  voice.lang = (form.elements.namedItem('lang') as HTMLSelectElement).value;
  avatar?.setMode('speaking');
  avatar?.setExpression('happy', 0.5);
  voice.say(
    voice.lang === 'fr'
      ? 'Bonjour ! Je suis votre avatar Breign. Parlez-moi simplement, je vous écoute, et vous pouvez me couper la parole quand vous voulez.'
      : 'Hello! I am your Breign avatar. Just talk to me, I am listening, and feel free to interrupt me at any time.',
  );
});

async function applySettings() {
  breign = new BreignService(settings);
  voice.lang = settings.lang;
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
void loadAvatar(settings.modelUrl || DEFAULT_MODEL);

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
    if (!settings.apiKey) return void login();
  }
  await applySettings();
  if (settings.apiKey && !settings.agentId) {
    openSettings('Connecté à Breign. Choisissez maintenant l’agent qui vous répondra.');
    $('load-agents').click();
  }
}
void boot();

// Accès console pour le débogage.
Object.assign(window, { stage, voice, conversation, THREE });
Object.defineProperty(window, 'avatar', { get: () => avatar });
