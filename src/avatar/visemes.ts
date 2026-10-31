/**
 * Visèmes au format Oculus/OVR (utilisé par Ready Player Me, Avaturn, Character Creator…)
 * et leur équivalent en blendshapes ARKit pour les modèles qui n'ont que ces derniers.
 */
export const VISEMES = [
  'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U',
] as const;
export type Viseme = (typeof VISEMES)[number];
export type Weights = Record<string, number>;

/** Composition ARKit de chaque visème (valeurs à pleine intensité). */
export const VISEME_TO_ARKIT: Record<Viseme, Weights> = {
  sil: {},
  PP: { mouthClose: 0.35, mouthPress_L: 0.55, mouthPress_R: 0.55, mouthRollLower: 0.25, jawOpen: 0.05 },
  FF: { mouthRollLower: 0.6, mouthUpperUp_L: 0.25, mouthUpperUp_R: 0.25, jawOpen: 0.08, mouthFunnel: 0.05 },
  TH: { jawOpen: 0.15, tongueOut: 0.35, mouthLowerDown_L: 0.1, mouthLowerDown_R: 0.1 },
  DD: { jawOpen: 0.2, mouthStretch_L: 0.15, mouthStretch_R: 0.15, mouthShrugUpper: 0.15 },
  kk: { jawOpen: 0.25, mouthStretch_L: 0.2, mouthStretch_R: 0.2 },
  CH: { mouthFunnel: 0.5, mouthPucker: 0.2, jawOpen: 0.15, mouthUpperUp_L: 0.2, mouthUpperUp_R: 0.2 },
  SS: { jawOpen: 0.06, mouthStretch_L: 0.35, mouthStretch_R: 0.35, mouthSmile_L: 0.1, mouthSmile_R: 0.1 },
  nn: { jawOpen: 0.15, mouthClose: 0.1, mouthStretch_L: 0.1, mouthStretch_R: 0.1 },
  RR: { mouthFunnel: 0.3, mouthPucker: 0.25, jawOpen: 0.15 },
  aa: { jawOpen: 0.55, mouthLowerDown_L: 0.3, mouthLowerDown_R: 0.3, mouthUpperUp_L: 0.1, mouthUpperUp_R: 0.1 },
  E: { jawOpen: 0.3, mouthStretch_L: 0.35, mouthStretch_R: 0.35, mouthSmile_L: 0.15, mouthSmile_R: 0.15 },
  I: { jawOpen: 0.15, mouthStretch_L: 0.45, mouthStretch_R: 0.45, mouthSmile_L: 0.25, mouthSmile_R: 0.25 },
  O: { jawOpen: 0.4, mouthFunnel: 0.55, mouthPucker: 0.2 },
  U: { jawOpen: 0.12, mouthPucker: 0.75, mouthFunnel: 0.3 },
};

/**
 * Conversion graphème → visème (approximative, pensée pour le français et l'anglais).
 * Sert au lipsync « textuel » quand aucun signal audio n'est analysable (voix du navigateur).
 */
export function textToVisemes(word: string): Viseme[] {
  const w = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
  const out: Viseme[] = [];
  const rules: Array<[RegExp, Viseme]> = [
    [/^(ou|oo|w)/, 'U'],
    [/^(au|eau|o)/, 'O'],
    [/^(ch|sh|j|ge|gi)/, 'CH'],
    [/^th/, 'TH'],
    [/^(ai|ei|e|é)/, 'E'],
    [/^(i|y)/, 'I'],
    [/^a/, 'aa'],
    [/^u/, 'U'],
    [/^[pbm]/, 'PP'],
    [/^[fv]/, 'FF'],
    [/^[szcx]/, 'SS'],
    [/^[tdl]/, 'DD'],
    [/^[kgq]/, 'kk'],
    [/^n/, 'nn'],
    [/^r/, 'RR'],
    [/^h/, 'sil'],
  ];
  let i = 0;
  while (i < w.length) {
    const rest = w.slice(i);
    const rule = rules.find(([re]) => re.test(rest));
    if (rule) {
      const len = rest.match(rule[0])![0].length;
      if (out[out.length - 1] !== rule[1]) out.push(rule[1]);
      i += len;
    } else {
      i += 1;
    }
  }
  return out;
}
