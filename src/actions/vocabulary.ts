/**
 * Vocabulaire des codes d'action que l'agent Breign peut glisser dans ses réponses,
 * par exemple `[[ACTION.EMOTION.AGGRESSIVE]]` ou `[[ACTION.FX.PULSE:3]]`.
 *
 * Ce fichier est la source unique : l'orbe s'en sert pour valider les codes, et la
 * documentation (docs/codes-action.md) ainsi que les consignes à donner au prompt de
 * l'agent en sont générées (`npm run actions:doc`). Il ne dépend de rien d'autre pour
 * pouvoir être lu par Node directement.
 *
 * Pour ajouter un code : ajoutez-le ici, gérez-le dans `Orb.applyAction`, puis
 * régénérez la documentation.
 */

export interface ActionValue {
  /** Nom du code, en majuscules (`AGGRESSIVE`). */
  name: string;
  /** Autres noms acceptés (`ANGRY`, `COLERE`…). */
  aliases?: string[];
  /** Ce que fait le code, en une phrase. */
  effect: string;
}

export interface ActionCategory {
  /** Nom de la catégorie, en majuscules (`EMOTION`). */
  name: string;
  title: string;
  /** Ce que fait la catégorie, et combien de temps l'effet dure. */
  about: string;
  /** Sens du paramètre optionnel `:x` (absent si la catégorie n'en prend pas). */
  param?: string;
  /** Exemple d'utilisation dans une réponse. */
  example: string;
  values: ActionValue[];
}

export const ACTION_CATEGORIES: ActionCategory[] = [
  {
    name: 'EMOTION',
    title: 'Émotions',
    about:
      "Change l'humeur de l'orbe : sa couleur et sa façon de bouger. Dure jusqu'à la réponse suivante ou jusqu'à une autre émotion.",
    param: 'intensité de 0 à 1 (1 par défaut), ex. `[[ACTION.EMOTION.SAD:0.4]]`',
    example: '[[ACTION.EMOTION.AGGRESSIVE]] Recule. Tout de suite.',
    values: [
      { name: 'NEUTRAL', aliases: ['NEUTRE'], effect: 'revient à la couleur et au comportement par défaut.' },
      { name: 'HAPPY', aliases: ['JOY', 'JOYEUX', 'CONTENT'], effect: 'jaune doré, lumineuse, rebondit et tourne gaiement.' },
      { name: 'SAD', aliases: ['TRISTE'], effect: 'bleu profond, terne, lente, s’affaisse un peu.' },
      {
        name: 'AGGRESSIVE',
        aliases: ['ANGRY', 'ANGER', 'AGRESSIF', 'COLERE'],
        effect: 'rouge vif, surface hérissée de pointes, tremble, tourne vite et bat comme un cœur en colère.',
      },
      { name: 'AFRAID', aliases: ['FEAR', 'SCARED', 'PEUR'], effect: 'violet pâle, se rétracte, frissonne et vacille.' },
      { name: 'CALM', aliases: ['SERENE', 'CALME'], effect: 'turquoise doux, lisse, respiration lente et ample.' },
      { name: 'CURIOUS', aliases: ['INTERESTED', 'CURIEUX'], effect: 'vert-cyan, anneaux de données allumés, s’agite avec intérêt.' },
      { name: 'SURPRISED', aliases: ['SURPRIS'], effect: 'blanc bleuté, sursaute et grossit d’un coup.' },
      { name: 'CONFUSED', aliases: ['PERPLEXED', 'PERPLEXE'], effect: 'violet, ondule de travers et grésille par moments.' },
      { name: 'PROUD', aliases: ['CONFIDENT', 'FIER'], effect: 'or, grande et rayonnante, tourne posément.' },
      { name: 'LOVING', aliases: ['TENDER', 'AFFECTION', 'TENDRE'], effect: 'rose, douce, pulse lentement.' },
    ],
  },
  {
    name: 'COLOR',
    title: 'Couleurs',
    about:
      "Impose une couleur, quelle que soit l'émotion. Dure jusqu'à la réponse suivante. `HEX` prend une couleur libre : `[[ACTION.COLOR.HEX:FF3300]]`.",
    param: 'pour `HEX` uniquement : la couleur en hexadécimal (`FF3300`)',
    example: 'Regarde, [[ACTION.COLOR.GREEN]] je passe au vert.',
    values: [
      { name: 'RED', aliases: ['ROUGE'], effect: 'rouge.' },
      { name: 'ORANGE', effect: 'orange.' },
      { name: 'YELLOW', aliases: ['JAUNE'], effect: 'jaune.' },
      { name: 'GREEN', aliases: ['VERT'], effect: 'vert.' },
      { name: 'CYAN', effect: 'cyan.' },
      { name: 'BLUE', aliases: ['BLEU'], effect: 'bleu.' },
      { name: 'VIOLET', aliases: ['PURPLE'], effect: 'violet.' },
      { name: 'PINK', aliases: ['ROSE'], effect: 'rose.' },
      { name: 'WHITE', aliases: ['BLANC'], effect: 'blanc.' },
      { name: 'HEX', effect: 'couleur libre donnée en paramètre.' },
      { name: 'DEFAULT', aliases: ['RESET'], effect: 'rend la couleur de l’émotion ou des réglages.' },
    ],
  },
  {
    name: 'SHAPE',
    title: 'Formes',
    about:
      "L'orbe se reconfigure en une forme et se tourne pour bien la montrer. Elle la garde jusqu'à la réponse suivante (ou pendant la durée donnée), puis reprend sa sphère.",
    param: 'durée en secondes, ex. `[[ACTION.SHAPE.HEART:4]]`',
    example: '[[ACTION.SHAPE.TRIANGLE]] Trois côtés, trois options.',
    values: [
      { name: 'SPHERE', aliases: ['ORB', 'CIRCLE', 'ROND'], effect: 'reprend sa forme de sphère.' },
      { name: 'TRIANGLE', aliases: ['PYRAMID', 'TETRAHEDRON'], effect: 'pyramide triangulaire, un triangle face à vous.' },
      { name: 'SQUARE', aliases: ['CUBE', 'CARRE'], effect: 'cube holographique, un carré face à vous.' },
      { name: 'HEART', aliases: ['COEUR'], effect: 'cœur.' },
      { name: 'RING', aliases: ['GYRO', 'GYROSCOPE', 'ANNEAUX'], effect: 'trois anneaux croisés autour d’un noyau.' },
      { name: 'KNOT', aliases: ['NOEUD'], effect: 'ruban de données noué.' },
    ],
  },
  {
    name: 'FX',
    title: 'Effets ponctuels',
    about:
      "Un geste précis, qui se superpose à l'émotion. Sans paramètre, il a lieu une fois ; avec une durée, il se répète pendant ce temps.",
    param: 'durée en secondes, ex. `[[ACTION.FX.BLINK:3]]`',
    example: 'Attention ! [[ACTION.FX.FLASH]] C’est important.',
    values: [
      { name: 'PULSE', aliases: ['BEAT'], effect: 'une pulsation franche, comme un battement.' },
      { name: 'BLINK', aliases: ['CLIGNOTE'], effect: 's’éteint et se rallume deux fois.' },
      { name: 'FLASH', effect: 'éclair de lumière vive.' },
      { name: 'SHAKE', aliases: ['TREMBLE'], effect: 'tremble.' },
      { name: 'SPIN', aliases: ['TOURNE'], effect: 'tourbillonne sur elle-même.' },
      { name: 'GLITCH', effect: 'grésille comme un hologramme qui décroche.' },
      { name: 'NOD', aliases: ['OUI'], effect: 'petit hochement (acquiescement).' },
    ],
  },
  {
    name: 'SIZE',
    title: 'Taille',
    about: "Change la taille de l'orbe jusqu'à la réponse suivante.",
    example: '[[ACTION.SIZE.SMALL]] Je me fais toute petite.',
    values: [
      { name: 'SMALL', aliases: ['PETIT'], effect: 'plus petite.' },
      { name: 'NORMAL', effect: 'taille normale.' },
      { name: 'LARGE', aliases: ['BIG', 'GRAND'], effect: 'plus grande.' },
    ],
  },
  {
    name: 'RESET',
    title: 'Remise à zéro',
    about: "`[[ACTION.RESET]]` annule aussitôt émotion, couleur, forme, taille et effets en cours.",
    example: '[[ACTION.RESET]] Bon, reprenons calmement.',
    values: [],
  },
];

/** Code d'action reconnu, normalisé (alias résolus). */
export interface ActionCode {
  /** Texte d'origine, tel qu'écrit par l'agent. */
  raw: string;
  /** Catégorie (`EMOTION`). */
  category: string;
  /** Valeur canonique (`AGGRESSIVE`), vide pour `RESET`. */
  value: string;
  /** Paramètre après `:` (`0.5`, `3`, `FF3300`), s'il y en a un. */
  param?: string;
}

const strip = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[\s-]+/g, '_');

/**
 * Reconnaît `CATEGORIE.VALEUR[:param]` (déjà sorti de ses crochets). Renvoie `undefined`
 * pour un code inconnu : il est alors retiré du texte mais ignoré.
 */
export function resolveAction(body: string, raw = body): ActionCode | undefined {
  const [path, ...rest] = body.split(':');
  const param = rest.join(':').trim() || undefined;
  const parts = path.split('.').map(strip).filter(Boolean);
  if (parts[0] === 'ACTION') parts.shift();
  const [cat, val = ''] = parts;
  const category = ACTION_CATEGORIES.find((c) => c.name === cat);
  if (!category) return undefined;
  if (category.values.length === 0) return { raw, category: category.name, value: '', param };
  // Tolère une couleur libre écrite directement : COLOR.#FF3300 ou COLOR.FF3300.
  const hex = /^#?([0-9A-F]{6}|[0-9A-F]{3})$/.exec(val);
  if (category.name === 'COLOR' && hex && !category.values.some((v) => v.name === val)) {
    return { raw, category: 'COLOR', value: 'HEX', param: hex[1] };
  }
  const value = category.values.find((v) => v.name === val || v.aliases?.includes(val));
  if (!value) return undefined;
  return { raw, category: category.name, value: value.name, param };
}

/** Tous les codes canoniques, pour les listes de suggestions. */
export function allActionCodes(): string[] {
  return ACTION_CATEGORIES.flatMap((c) =>
    c.values.length ? c.values.map((v) => `[[ACTION.${c.name}.${v.name}]]`) : [`[[ACTION.${c.name}]]`],
  );
}

/**
 * Consignes à coller dans le prompt système de l'agent Breign, pour qu'il sache quels
 * codes il peut utiliser et comment.
 */
export function actionPrompt(): string {
  const lines: string[] = [
    "Tu t'incarnes dans une orbe holographique animée. Tu peux piloter son apparence en glissant des codes d'action dans tes réponses.",
    "Format : [[ACTION.CATEGORIE.VALEUR]] ou [[ACTION.CATEGORIE.VALEUR:parametre]], en majuscules, sans espace. Les codes ne sont ni affichés ni prononcés : ils s'appliquent au moment où la phrase qui les contient est dite.",
    'Règles :',
    "- Commence chaque réponse par une émotion qui correspond à ton ton, par exemple [[ACTION.EMOTION.CALM]].",
    '- Place les autres codes juste avant les mots qu’ils doivent accompagner.',
    '- Reste sobre : un à trois codes par réponse suffisent en général.',
    "- N'invente pas de code : utilise seulement ceux de la liste. N'explique jamais les codes à l'utilisateur.",
    "- L'émotion, la couleur, la forme et la taille durent jusqu'à ta réponse suivante.",
    '',
    'Codes disponibles :',
  ];
  for (const c of ACTION_CATEGORIES) {
    lines.push('', `${c.title} — ${c.about.replace(/`/g, '')}`);
    if (c.param) lines.push(`Paramètre : ${c.param.replace(/`/g, '')}.`);
    if (!c.values.length) lines.push(`- [[ACTION.${c.name}]]`);
    for (const v of c.values) lines.push(`- [[ACTION.${c.name}.${v.name}]] : ${v.effect}`);
    lines.push(`Exemple : « ${c.example} »`);
  }
  return lines.join('\n');
}
