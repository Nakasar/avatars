/**
 * Humeurs de l'orbe, pilotées par les codes `[[ACTION.EMOTION.…]]` : une teinte et une
 * façon de bouger. Les valeurs sont des réglages autour de l'humeur neutre (1 = inchangé,
 * 0 = aucun effet pour les effets additionnels).
 */
export interface Palette {
  main: number;
  accent: number;
  core: number;
}

export interface Mood {
  /** Teinte ; absente = couleur choisie dans les réglages. */
  palette?: Palette;
  /** Luminosité. */
  bright: number;
  /** Vitesse de rotation. */
  spin: number;
  /** Vitesse des flux de données et des étincelles. */
  flow: number;
  /** Quantité d'étincelles. */
  sparks: number;
  /** Anneaux de données allumés en plus (0–1). */
  rings: number;
  /** Taille. */
  scale: number;
  /** Vitesse et ampleur de la respiration. */
  breath: number;
  breathAmp: number;
  /** Surface hérissée de pointes (0 lisse – 1 très piquante). */
  spikes: number;
  /** Ondulation de travers, asymétrique. */
  wobble: number;
  /** Tremblement. */
  jitter: number;
  /** Vacillement de la lumière. */
  flicker: number;
  /** Rebond vertical (joie). */
  bob: number;
  /** Décalage vertical (négatif = s'affaisse). */
  lift: number;
  /** Battement de cœur : intervalle en secondes (0 = aucun) et force. */
  beat: number;
  beatForce: number;
  /** Grésillement : nombre moyen de décrochages par seconde. */
  glitch: number;
  /** Petit sursaut au moment où l'humeur arrive. */
  kick: number;
}

export const NEUTRAL: Mood = {
  bright: 1, spin: 1, flow: 1, sparks: 1, rings: 0, scale: 1, breath: 1, breathAmp: 1,
  spikes: 0, wobble: 0, jitter: 0, flicker: 0, bob: 0, lift: 0, beat: 0, beatForce: 0, glitch: 0, kick: 0,
};

const mood = (m: Partial<Mood>): Mood => ({ ...NEUTRAL, ...m });

export const MOODS: Record<string, Mood> = {
  NEUTRAL,
  HAPPY: mood({
    palette: { main: 0xffc21f, accent: 0xff7ad9, core: 0xfff6d6 },
    bright: 1.35, spin: 1.6, flow: 1.4, sparks: 1.6, scale: 1.05, breath: 1.4, bob: 1, kick: 0.25,
  }),
  SAD: mood({
    palette: { main: 0x2a4bd6, accent: 0x7aa0ff, core: 0xc9d6ff },
    bright: 0.6, spin: 0.4, flow: 0.5, sparks: 0.3, scale: 0.94, breath: 0.6, breathAmp: 1.4, lift: -0.08,
  }),
  AGGRESSIVE: mood({
    palette: { main: 0xff1f1f, accent: 0xffb31f, core: 0xffd2c4 },
    bright: 1.4, spin: 2.6, flow: 2.2, sparks: 2.2, rings: 0.4, scale: 1.05, breath: 2,
    spikes: 1, jitter: 0.6, beat: 0.75, beatForce: 0.9, kick: 0.5,
  }),
  AFRAID: mood({
    palette: { main: 0xb58cff, accent: 0x8ff3ff, core: 0xf2ebff },
    bright: 0.8, spin: 0.6, flow: 0.8, sparks: 0.6, scale: 0.82, breath: 2.6, breathAmp: 0.6,
    jitter: 0.45, flicker: 0.5, kick: -0.3,
  }),
  CALM: mood({
    palette: { main: 0x2fe0c8, accent: 0x9fffe8, core: 0xe0fffa },
    bright: 0.95, spin: 0.55, flow: 0.6, sparks: 0.6, breath: 0.55, breathAmp: 2,
  }),
  CURIOUS: mood({
    palette: { main: 0x3dff9a, accent: 0x5ad8ff, core: 0xe2fff0 },
    bright: 1.1, spin: 1.4, flow: 1.2, sparks: 1.2, rings: 0.6, bob: 0.4, wobble: 0.3, kick: 0.15,
  }),
  SURPRISED: mood({
    palette: { main: 0xbfe6ff, accent: 0xffffff, core: 0xffffff },
    bright: 1.4, spin: 1.8, flow: 1.4, sparks: 1.5, scale: 1.15, kick: 0.9,
  }),
  CONFUSED: mood({
    palette: { main: 0x8b3dff, accent: 0x3dffc8, core: 0xe6d6ff },
    spin: 0.8, flow: 0.9, wobble: 1, glitch: 0.6,
  }),
  PROUD: mood({
    palette: { main: 0xffb000, accent: 0xffffff, core: 0xfff1c4 },
    bright: 1.3, spin: 0.8, sparks: 1.3, rings: 0.3, scale: 1.18, breath: 0.8,
  }),
  LOVING: mood({
    palette: { main: 0xff5aa8, accent: 0xffb3d9, core: 0xffe6f2 },
    bright: 1.15, spin: 0.7, flow: 0.8, breath: 0.8, beat: 1.1, beatForce: 0.35,
  }),
};

/** Couleurs nommées de `[[ACTION.COLOR.…]]`. */
export const COLORS: Record<string, number> = {
  RED: 0xff2a2a,
  ORANGE: 0xff9a1f,
  YELLOW: 0xffd21f,
  GREEN: 0x1fe08a,
  CYAN: 0x1fe0ff,
  BLUE: 0x2f8cff,
  VIOLET: 0x9b5cff,
  PINK: 0xff5ab4,
  WHITE: 0xe8f0ff,
};

/** Formes de `[[ACTION.SHAPE.…]]` → indice de forme de l'orbe. */
export const SHAPE_INDEX: Record<string, number> = {
  SPHERE: 0, RING: 1, SQUARE: 2, KNOT: 3, TRIANGLE: 4, HEART: 5,
};

/**
 * Pour bien montrer une forme, l'orbe se tourne face à la caméra : période de rotation
 * qui ramène la forme dans sa pose de face (0 = forme sans face particulière).
 */
export const SHAPE_FACING: Record<number, number> = {
  2: Math.PI / 2, // un carré face à vous
  4: Math.PI * 2, // un triangle, pointe en haut
  5: Math.PI, // un cœur
};

export const SIZES: Record<string, number> = { SMALL: 0.7, NORMAL: 1, LARGE: 1.3 };

export function blendMood(k: number, m: Mood): Mood {
  const out = { ...m };
  for (const key of Object.keys(NEUTRAL) as Array<keyof Mood>) {
    if (key === 'palette') continue;
    (out[key] as number) = NEUTRAL[key] as number + ((m[key] as number) - (NEUTRAL[key] as number)) * k;
  }
  return out;
}
