/**
 * Écoute continue du micro avec détection d'activité vocale (VAD) et de fin de tour.
 *
 * - Le niveau sonore est mesuré par trames de 20 ms et comparé à un bruit de fond estimé en
 *   continu (il suit le minimum, et remonte lentement si la pièce devient plus bruyante).
 * - Une prise de parole commence après `startMs` de voix continue ; on garde `preRollMs`
 *   d'audio avant ce moment pour ne pas couper la première syllabe.
 * - Le tour se termine après `endSilenceMs` de silence : c'est le moment d'envoyer la phrase.
 * - Pendant que l'avatar parle, le seuil est relevé (`bargeInBoostDb`) et la voix doit durer
 *   plus longtemps (`bargeInStartMs`) avant d'être prise pour une interruption : on évite ainsi
 *   que l'écho résiduel de l'avatar ne l'interrompe lui-même.
 */
export interface VadOptions {
  startMs: number;
  endSilenceMs: number;
  preRollMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  /** Écart minimal au bruit de fond pour considérer qu'on parle (dB). */
  thresholdDb: number;
  /** Niveau absolu minimal (dBFS) en dessous duquel ce n'est jamais de la voix. */
  floorDb: number;
  bargeInBoostDb: number;
  bargeInStartMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  startMs: 160,
  endSilenceMs: 750,
  preRollMs: 400,
  minSpeechMs: 350,
  maxUtteranceMs: 30_000,
  thresholdDb: 11,
  floorDb: -58,
  bargeInBoostDb: 9,
  bargeInStartMs: 320,
};

export interface Utterance {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

const FRAME_MS = 20;

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('breign-mic-tap', Tap);
`;

export class VoiceActivity {
  opts: VadOptions;
  /** Vrai quand l'avatar parle : active le mode « interruption » (seuils plus stricts). */
  avatarSpeaking = false;
  /** Coupe la détection sans fermer le micro (ex. pendant les réglages). */
  paused = false;

  onSpeechStart?: (bargeIn: boolean) => void;
  onSpeechEnd?: (u: Utterance) => void;
  /** Parole trop courte (toux, clic) : à ignorer. */
  onSpeechCancel?: () => void;
  /** Niveau courant, 0–1, pour l'indicateur visuel. */
  onLevel?: (level: number, speaking: boolean) => void;

  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private sampleRate = 48000;
  private frameSize = 960;
  private pending: number[] = [];

  private noiseDb = -50;
  private preRoll: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private inSpeech = false;
  private voicedMs = 0;
  private silenceMs = 0;
  private speechMs = 0;

  constructor(private ctx: AudioContext, opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
  }

  get listening() {
    return Boolean(this.stream);
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.sampleRate = this.ctx.sampleRate;
    this.frameSize = Math.round((this.sampleRate * FRAME_MS) / 1000);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'breign-mic-tap');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
    // Le nœud doit être relié à la sortie pour être cadencé ; un gain nul évite tout retour.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.reset();
  }

  private reset() {
    this.inSpeech = false;
    this.speech = [];
    this.voicedMs = this.silenceMs = this.speechMs = 0;
  }

  private push(chunk: Float32Array) {
    for (let i = 0; i < chunk.length; i++) this.pending.push(chunk[i]);
    while (this.pending.length >= this.frameSize) {
      this.frame(Float32Array.from(this.pending.splice(0, this.frameSize)));
    }
  }

  private frame(f: Float32Array) {
    const o = this.opts;
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const db = 10 * Math.log10(sum / f.length + 1e-12);

    // Bruit de fond : descend vite vers les minima, remonte lentement (~3 dB/s).
    if (db < this.noiseDb) this.noiseDb += (db - this.noiseDb) * 0.2;
    else if (!this.inSpeech) this.noiseDb += Math.min(db - this.noiseDb, (3 * FRAME_MS) / 1000);
    this.noiseDb = Math.max(this.noiseDb, -90);

    const boost = this.avatarSpeaking ? o.bargeInBoostDb : 0;
    const voiced =
      !this.paused && db > Math.max(o.floorDb + boost, this.noiseDb + o.thresholdDb + boost);
    this.onLevel?.(Math.min(1, Math.max(0, (db - this.noiseDb) / 40)), this.inSpeech);

    // Mémoire tampon de pré-écoute.
    this.preRoll.push(f);
    const maxPre = Math.ceil(o.preRollMs / FRAME_MS);
    if (this.preRoll.length > maxPre) this.preRoll.shift();

    if (!this.inSpeech) {
      this.voicedMs = voiced ? this.voicedMs + FRAME_MS : Math.max(0, this.voicedMs - FRAME_MS * 2);
      const needed = this.avatarSpeaking ? o.bargeInStartMs : o.startMs;
      if (this.voicedMs >= needed) {
        this.inSpeech = true;
        this.speech = [...this.preRoll];
        this.speechMs = this.voicedMs;
        this.silenceMs = 0;
        this.onSpeechStart?.(this.avatarSpeaking);
      }
      return;
    }

    this.speech.push(f);
    if (voiced) {
      this.silenceMs = 0;
      this.speechMs += FRAME_MS;
    } else {
      this.silenceMs += FRAME_MS;
    }
    const total = this.speech.length * FRAME_MS;
    if (this.silenceMs >= o.endSilenceMs || total >= o.maxUtteranceMs) {
      const keep = this.speech.length - Math.floor(Math.max(0, this.silenceMs - 200) / FRAME_MS);
      const frames = this.speech.slice(0, keep);
      const spoken = this.speechMs;
      this.reset();
      if (spoken < o.minSpeechMs) {
        this.onSpeechCancel?.();
        return;
      }
      const samples = new Float32Array(frames.length * this.frameSize);
      frames.forEach((fr, i) => samples.set(fr, i * this.frameSize));
      this.onSpeechEnd?.({ samples, sampleRate: this.sampleRate, durationMs: frames.length * FRAME_MS });
    }
  }
}

/** Rééchantillonne en 16 kHz mono et encode en WAV PCM 16 bits (format de la transcription). */
export async function toWav16k(u: Utterance): Promise<Blob> {
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil((u.samples.length * rate) / u.sampleRate), rate);
  const buf = offline.createBuffer(1, u.samples.length, u.sampleRate);
  buf.copyToChannel(u.samples as Float32Array<ArrayBuffer>, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const out = await offline.startRendering();
  return encodeWav(out.getChannelData(0), rate);
}

export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
