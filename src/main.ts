import * as THREE from 'three';
import { Stage } from './scene/Stage';
import { Avatar, type Expression } from './avatar/Avatar';
import { Recorder, SentenceChunker, Voice } from './avatar/Voice';
import { BreignService, describeError, type BreignSettings } from './breign/BreignService';
import { loadSettings, saveSettings, type AppSettings } from './settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage($('stage'), {
  quality: (new URLSearchParams(location.search).get('quality') as 'high' | 'medium' | 'low') ?? 'high',
});

let settings: AppSettings = loadSettings();
let breign = new BreignService(settings);
const voice = new Voice((text) => breign.textToSpeech(text), settings.lang);
let avatar: Avatar | undefined;

// ---------------------------------------------------------------- Avatar
async function loadAvatar(url: string) {
  $('loading').classList.remove('hidden');
  try {
    const next = await Avatar.load(url, stage.renderer);
    if (avatar) stage.scene.remove(avatar.root);
    avatar = next;
    stage.scene.add(avatar.root);
    stage.frame(avatar.root, avatar.root.localToWorld(avatar.focus.clone()), avatar.framingHeight);
    avatar.setExpression('listening', 0.8);
    console.info('[avatar] blendshapes :', avatar.morphTargetNames.length, avatar.morphTargetNames);
  } catch (e) {
    addMessage('error', `Impossible de charger le modèle 3D : ${e instanceof Error ? e.message : e}`);
  } finally {
    $('loading').classList.add('hidden');
  }
}

const DEFAULT_MODEL = '/models/mpfb.glb';

stage.onUpdate((dt, t) => {
  if (!avatar) return;
  const { visemes, energy } = voice.sample(dt);
  avatar.setVisemes(visemes, voice.speaking ? energy : 0);
  avatar.lookAt(stage.camera.position);
  avatar.update(dt, t);
});

voice.onSpeakingChange = (speaking) => {
  document.body.classList.toggle('speaking', speaking);
  if (!speaking && !busy) avatar?.setExpression('listening', 0.8);
};

// ---------------------------------------------------------------- Chat
let busy = false;
let abort: AbortController | undefined;

function addMessage(kind: 'user' | 'agent' | 'error', text: string) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

function setStatus(text: string) {
  $('status').textContent = text;
}

async function ask(text: string) {
  text = text.trim();
  if (!text || busy) return;
  voice.unlock();
  voice.stop();
  addMessage('user', text);

  if (!breign.configured) {
    addMessage('error', 'Renseignez une clé API et un agent dans les réglages (⚙).');
    ($('settings') as HTMLDialogElement).showModal();
    return;
  }

  busy = true;
  document.body.classList.add('thinking');
  avatar?.setExpression('thinking', 0.9);
  setStatus('Réflexion…');
  const bubble = addMessage('agent', '…');
  const chunker = new SentenceChunker();
  abort = new AbortController();
  let spoke = false;

  try {
    const final = await breign.send(
      text,
      ({ text: partial, done }) => {
        bubble.textContent = partial || '…';
        $('messages').scrollTop = $('messages').scrollHeight;
        for (const sentence of chunker.push(partial, done)) {
          if (!spoke) {
            spoke = true;
            document.body.classList.remove('thinking');
            avatar?.setExpression(moodOf(partial), 0.6);
            setStatus('Parle');
          }
          voice.say(sentence);
        }
      },
      abort.signal,
    );
    bubble.textContent = final;
    for (const sentence of chunker.push(final, true)) voice.say(sentence);
    setStatus('Connecté');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      bubble.remove();
      addMessage('error', await describeError(e));
      setStatus('Erreur');
      avatar?.setExpression('sad', 0.4);
    }
  } finally {
    busy = false;
    document.body.classList.remove('thinking');
  }
}

/** Humeur simple déduite du texte, pour colorer l'expression pendant la parole. */
function moodOf(text: string): Expression {
  if (/[!😀😄😊🙂]|ravi|super|génial|parfait|bravo|great|glad|happy/i.test(text)) return 'happy';
  if (/désolé|malheureusement|sorry|unfortunately|hélas/i.test(text)) return 'sad';
  if (/\?\s*$/.test(text)) return 'surprised';
  return 'neutral';
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('input');
  void ask(input.value);
  input.value = '';
});

// ---------------------------------------------------------------- Micro (maintenir pour parler)
const recorder = new Recorder();
const mic = $<HTMLButtonElement>('mic');
let recording = false;
async function micDown(e: Event) {
  e.preventDefault();
  if (recording || busy) return;
  voice.unlock();
  voice.stop();
  try {
    await recorder.start();
    recording = true;
    mic.classList.add('recording');
    setStatus('Écoute…');
    avatar?.setExpression('listening', 1);
  } catch (err) {
    addMessage('error', `Micro indisponible : ${err instanceof Error ? err.message : err}`);
  }
}
async function micUp() {
  if (!recording) return;
  recording = false;
  mic.classList.remove('recording');
  setStatus('Transcription…');
  try {
    const wav = await recorder.stop(voice.ctx);
    const text = await breign.speechToText(wav);
    if (text.trim()) await ask(text);
    else setStatus('Rien entendu');
  } catch (err) {
    addMessage('error', await describeError(err));
    setStatus('Erreur');
  }
}
mic.addEventListener('pointerdown', micDown);
window.addEventListener('pointerup', micUp);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    abort?.abort();
    voice.stop();
  }
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

$('settings-btn').addEventListener('click', () => {
  fillForm();
  dialog.showModal();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  const prevModel = settings.modelUrl;
  settings = readForm();
  saveSettings(settings);
  applySettings();
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
  voice.stop();
  voice.lang = (form.elements.namedItem('lang') as HTMLSelectElement).value;
  avatar?.setExpression('happy', 0.5);
  const demo =
    voice.lang === 'fr'
      ? 'Bonjour ! Je suis votre avatar Breign. Posez-moi une question, je vous réponds de vive voix.'
      : 'Hello! I am your Breign avatar. Ask me anything and I will answer out loud.';
  voice.say(demo);
});

async function applySettings() {
  breign = new BreignService(settings);
  voice.lang = settings.lang;
  if (!breign.configured) {
    setStatus('Non connecté');
    return;
  }
  setStatus('Connexion…');
  try {
    const agent = await breign.getAgent();
    $('agent-name').textContent = agent.name;
    setStatus('Connecté');
  } catch (e) {
    setStatus('Erreur');
    addMessage('error', await describeError(e));
  }
}

// ---------------------------------------------------------------- Démarrage
void loadAvatar(settings.modelUrl || DEFAULT_MODEL);
void applySettings();

// Accès console pour le débogage.
Object.assign(window, { stage, voice, THREE });
Object.defineProperty(window, 'avatar', { get: () => avatar });
