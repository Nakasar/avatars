import { textToVisemes, type Viseme } from './visemes';

export type VisemeFrame = Partial<Record<Viseme, number>>;

/**
 * Lipsync piloté par l'audio : analyse spectrale en temps réel du signal joué.
 *
 * Heuristique formantique simple :
 *  - énergie globale → ouverture de la mâchoire ;
 *  - dominance des basses fréquences (F1/F2 proches, ~250–900 Hz) → voyelles arrondies (O, U) ;
 *  - dominance des médiums (F2 haut, ~1,5–3 kHz) → voyelles étirées (E, I) ;
 *  - énergie haute fréquence (> 4 kHz) sans voisement → fricatives (S, F, CH) ;
 *  - silence bref après de l'énergie → occlusives (P, B, M).
 */
export class AudioLipsync {
  private freq: Uint8Array<ArrayBuffer>;
  private time: Uint8Array<ArrayBuffer>;
  private peak = 0.05;
  private lastRms = 0;
  private smoothed: VisemeFrame = {};

  constructor(private analyser: AnalyserNode) {
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
  }

  /** Retourne les poids de visèmes pour l'image courante, et l'énergie vocale (0–1). */
  sample(dt: number): { visemes: VisemeFrame; energy: number } {
    const a = this.analyser;
    a.getByteTimeDomainData(this.time);
    a.getByteFrequencyData(this.freq);

    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    // Gain automatique : on normalise par un pic qui décroît lentement.
    this.peak = Math.max(rms, this.peak * (1 - dt * 0.15), 0.02);
    const level = Math.min(1, rms / this.peak);

    const band = (lo: number, hi: number) => {
      const hz = a.context.sampleRate / 2 / this.freq.length;
      const i0 = Math.floor(lo / hz);
      const i1 = Math.min(this.freq.length - 1, Math.ceil(hi / hz));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += this.freq[i];
      return s / ((i1 - i0 + 1) * 255);
    };
    const low = band(250, 900);
    const mid = band(1400, 3000);
    const high = band(4000, 8000);
    const total = low + mid + high + 1e-4;

    const voiced = smoothstep(0.08, 0.35, level);
    const open = voiced * smoothstep(0.15, 0.9, level);
    const round = smoothstep(0.45, 0.7, low / total);
    const spread = smoothstep(0.25, 0.45, mid / total);
    const fric = smoothstep(0.25, 0.5, high / total) * smoothstep(0.03, 0.12, rms);
    const plosive = this.lastRms > 0.05 && rms < this.lastRms * 0.35 ? 1 : 0;
    this.lastRms = rms;

    const target: VisemeFrame = {
      aa: open * (1 - round) * (1 - spread),
      O: open * round,
      U: voiced * round * (1 - open) * 0.9,
      E: open * spread * 0.8,
      I: voiced * spread * (1 - open) * 0.8,
      SS: fric * (1 - voiced * 0.5),
      FF: fric * 0.25,
      PP: plosive * 0.7,
      DD: voiced * (1 - open) * 0.25,
      sil: 1 - voiced,
    };

    // Attaque rapide, relâchement un peu plus lent : bouche vive mais pas saccadée.
    for (const k of Object.keys(target) as Viseme[]) {
      const cur = this.smoothed[k] ?? 0;
      const tgt = target[k] ?? 0;
      const rate = tgt > cur ? 28 : 14;
      this.smoothed[k] = cur + (tgt - cur) * Math.min(1, dt * rate);
    }
    return { visemes: { ...this.smoothed }, energy: open };
  }
}

/**
 * Lipsync piloté par le texte : quand on ne peut pas analyser l'audio (voix de synthèse du
 * navigateur), on rejoue une séquence de visèmes déduite des mots, calée sur les événements
 * « boundary » de la synthèse vocale.
 */
export class TextLipsync {
  private queue: Array<{ v: Viseme; start: number; end: number }> = [];
  private clock = 0;
  private smoothed: VisemeFrame = {};

  /** Programme un mot à partir de maintenant ; `rate` = débit de la voix (1 = normal). */
  pushWord(word: string, rate = 1) {
    const visemes = textToVisemes(word);
    const per = 0.075 / rate;
    let t = Math.max(this.clock, this.queue.at(-1)?.end ?? 0);
    for (const v of visemes) {
      this.queue.push({ v, start: t, end: t + per });
      t += per;
    }
  }

  clear() {
    this.queue = [];
  }

  sample(dt: number): { visemes: VisemeFrame; energy: number } {
    this.clock += dt;
    this.queue = this.queue.filter((q) => q.end > this.clock - 0.05);
    const active = this.queue.find((q) => q.start <= this.clock && q.end > this.clock);
    const target: VisemeFrame = active ? { [active.v]: 1 } : { sil: 1 };
    const keys = new Set([...Object.keys(this.smoothed), ...Object.keys(target)]) as Set<Viseme>;
    for (const k of keys) {
      const cur = this.smoothed[k] ?? 0;
      const tgt = target[k] ?? 0;
      this.smoothed[k] = cur + (tgt - cur) * Math.min(1, dt * 22);
    }
    const energy = active && active.v !== 'sil' ? 0.6 : 0;
    return { visemes: { ...this.smoothed }, energy };
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
