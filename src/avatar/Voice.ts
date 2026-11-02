import { AudioLipsync, TextLipsync, type VisemeFrame } from './lipsync';

export type TtsFn = (text: string) => Promise<string | null>;

interface Utterance {
  text: string;
  audio: Promise<AudioBuffer | null>;
}

/**
 * Voix de l'avatar : file de phrases à dire, synthèse (Breign ou navigateur), lecture et
 * lipsync. Les phrases sont synthétisées en avance pendant que la précédente est jouée.
 */
export class Voice {
  readonly ctx = new AudioContext();
  private analyser = this.ctx.createAnalyser();
  private audioLipsync = new AudioLipsync(this.analyser);
  private textLipsync = new TextLipsync();
  private queue: Utterance[] = [];
  private playing = false;
  private mode: 'audio' | 'text' | 'idle' = 'idle';
  private current?: AudioBufferSourceNode;
  private generation = 0;

  onSpeakingChange?: (speaking: boolean) => void;

  constructor(private tts: TtsFn, public lang = 'fr') {
    this.analyser.connect(this.ctx.destination);
  }

  /** À appeler depuis un geste utilisateur (politique d'autoplay des navigateurs). */
  unlock() {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get speaking() {
    return this.playing;
  }

  say(text: string) {
    const clean = stripMarkdown(text);
    if (!clean) return;
    this.queue.push({ text: clean, audio: this.synthesize(clean) });
    if (!this.playing) void this.drain();
  }

  stop() {
    this.generation++;
    this.queue = [];
    this.current?.stop();
    speechSynthesis.cancel();
    this.textLipsync.clear();
    this.setPlaying(false);
  }

  sample(dt: number): { visemes: VisemeFrame; energy: number } {
    if (this.mode === 'audio') return this.audioLipsync.sample(dt);
    return this.textLipsync.sample(dt);
  }

  private async synthesize(text: string): Promise<AudioBuffer | null> {
    try {
      const src = await this.tts(text);
      if (!src) return null;
      const res = await fetch(src);
      if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch (e) {
      console.warn('[voice] synthèse Breign indisponible, voix du navigateur utilisée', e);
      return null;
    }
  }

  private async drain() {
    const gen = this.generation;
    this.setPlaying(true);
    while (this.queue.length && gen === this.generation) {
      const u = this.queue.shift()!;
      const buffer = await u.audio;
      if (gen !== this.generation) return;
      if (buffer) await this.playBuffer(buffer);
      else await this.speakWithBrowser(u.text);
    }
    if (gen === this.generation) this.setPlaying(false);
  }

  private playBuffer(buffer: AudioBuffer) {
    return new Promise<void>((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => resolve();
      this.current = src;
      this.mode = 'audio';
      src.start();
    });
  }

  private speakWithBrowser(text: string) {
    return new Promise<void>((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      const voice = pickVoice(this.lang);
      if (voice) u.voice = voice;
      u.rate = 1;
      this.mode = 'text';
      let sawBoundary = false;
      u.onboundary = (ev) => {
        if (ev.name !== 'word') return;
        sawBoundary = true;
        const word = text.slice(ev.charIndex).split(/\s/)[0];
        this.textLipsync.pushWord(word, u.rate);
      };
      u.onstart = () => {
        // Certains navigateurs n'émettent pas d'événements « boundary » : on programme tout.
        setTimeout(() => {
          if (!sawBoundary) for (const w of text.split(/\s+/)) this.textLipsync.pushWord(w, u.rate);
        }, 150);
      };
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    if (!p) this.mode = 'idle';
    this.onSpeakingChange?.(p);
  }
}

/**
 * Découpe un texte qui arrive au fil de l'eau en phrases complètes, pour les dire dès
 * qu'elles sont prêtes.
 */
export class SentenceChunker {
  private consumed = 0;

  /** Renvoie les nouvelles phrases complètes de `fullText` (texte cumulatif). */
  push(fullText: string, final = false): string[] {
    const rest = fullText.slice(this.consumed);
    const out: string[] = [];
    const re = /[^.!?…\n]+(?:[.!?…]+["»”)]*\s+|\n+)/g;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = re.exec(rest))) {
      // Évite de couper trop court (« M. », « 1. »…) : au moins 25 caractères par morceau.
      if (m.index + m[0].length - end < 25 && !m[0].includes('\n')) continue;
      out.push(rest.slice(end, m.index + m[0].length).trim());
      end = m.index + m[0].length;
    }
    if (final && rest.slice(end).trim()) {
      out.push(rest.slice(end).trim());
      end = rest.length;
    }
    this.consumed += end;
    return out.filter(Boolean);
  }
}

function stripMarkdown(s: string) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  return (
    voices.find((v) => /natural|neural|premium|enhanced|google/i.test(v.name)) ?? voices[0]
  );
}
