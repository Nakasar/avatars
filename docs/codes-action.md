# Codes d’action de l’orbe

<!-- Fichier généré par `npm run actions:doc` depuis src/actions/vocabulary.ts : modifiez la source, pas ce fichier. -->

L’agent Breign peut piloter l’apparence de l’orbe en glissant des **codes d’action** dans ses réponses :

```
[[ACTION.EMOTION.AGGRESSIVE]] Recule. [[ACTION.FX.PULSE]] Tout de suite.
```

- Les codes sont **retirés** du texte affiché et ne sont **pas prononcés**.
- Chacun se déclenche au moment où la voix arrive à sa place dans la phrase (un code en début de réponse s’applique dès que l’orbe commence à parler).
- Format : `[[ACTION.CATEGORIE.VALEUR]]`, ou `[[ACTION.CATEGORIE.VALEUR:paramètre]]`. La casse, les accents et quelques alias français (`[[ACTION.EMOTION.COLERE]]`, `[[ACTION.SHAPE.COEUR]]`) sont tolérés. Un code inconnu est retiré du texte et ignoré.
- L’émotion, la couleur, la forme et la taille durent jusqu’à la **réponse suivante** (ou jusqu’à `[[ACTION.RESET]]`).
- Avec l’apparence humaine, seules les émotions proches d’une expression du visage sont jouées.

Pour essayer un code sans passer par l’agent : Réglages (⚙) → « Codes d’action » → Jouer, ou dans la console `actions("[[ACTION.SHAPE.HEART]]")`.

## Émotions — `EMOTION`

Change l'humeur de l'orbe : sa couleur et sa façon de bouger. Dure jusqu'à la réponse suivante ou jusqu'à une autre émotion.

Paramètre : intensité de 0 à 1 (1 par défaut), ex. `[[ACTION.EMOTION.SAD:0.4]]`.

| Code | Alias | Effet |
|---|---|---|
| `[[ACTION.EMOTION.NEUTRAL]]` | `NEUTRE` | revient à la couleur et au comportement par défaut. |
| `[[ACTION.EMOTION.HAPPY]]` | `JOY`, `JOYEUX`, `CONTENT` | jaune doré, lumineuse, rebondit et tourne gaiement. |
| `[[ACTION.EMOTION.SAD]]` | `TRISTE` | bleu profond, terne, lente, s’affaisse un peu. |
| `[[ACTION.EMOTION.AGGRESSIVE]]` | `ANGRY`, `ANGER`, `AGRESSIF`, `COLERE` | rouge vif, surface hérissée de pointes, tremble, tourne vite et bat comme un cœur en colère. |
| `[[ACTION.EMOTION.AFRAID]]` | `FEAR`, `SCARED`, `PEUR` | violet pâle, se rétracte, frissonne et vacille. |
| `[[ACTION.EMOTION.CALM]]` | `SERENE`, `CALME` | turquoise doux, lisse, respiration lente et ample. |
| `[[ACTION.EMOTION.CURIOUS]]` | `INTERESTED`, `CURIEUX` | vert-cyan, anneaux de données allumés, s’agite avec intérêt. |
| `[[ACTION.EMOTION.SURPRISED]]` | `SURPRIS` | blanc bleuté, sursaute et grossit d’un coup. |
| `[[ACTION.EMOTION.CONFUSED]]` | `PERPLEXED`, `PERPLEXE` | violet, ondule de travers et grésille par moments. |
| `[[ACTION.EMOTION.PROUD]]` | `CONFIDENT`, `FIER` | or, grande et rayonnante, tourne posément. |
| `[[ACTION.EMOTION.LOVING]]` | `TENDER`, `AFFECTION`, `TENDRE` | rose, douce, pulse lentement. |

Exemple : `[[ACTION.EMOTION.AGGRESSIVE]] Recule. Tout de suite.`

## Couleurs — `COLOR`

Impose une couleur, quelle que soit l'émotion. Dure jusqu'à la réponse suivante. `HEX` prend une couleur libre : `[[ACTION.COLOR.HEX:FF3300]]`.

Paramètre : pour `HEX` uniquement : la couleur en hexadécimal (`FF3300`).

| Code | Alias | Effet |
|---|---|---|
| `[[ACTION.COLOR.RED]]` | `ROUGE` | rouge. |
| `[[ACTION.COLOR.ORANGE]]` |  | orange. |
| `[[ACTION.COLOR.YELLOW]]` | `JAUNE` | jaune. |
| `[[ACTION.COLOR.GREEN]]` | `VERT` | vert. |
| `[[ACTION.COLOR.CYAN]]` |  | cyan. |
| `[[ACTION.COLOR.BLUE]]` | `BLEU` | bleu. |
| `[[ACTION.COLOR.VIOLET]]` | `PURPLE` | violet. |
| `[[ACTION.COLOR.PINK]]` | `ROSE` | rose. |
| `[[ACTION.COLOR.WHITE]]` | `BLANC` | blanc. |
| `[[ACTION.COLOR.HEX]]` |  | couleur libre donnée en paramètre. |
| `[[ACTION.COLOR.DEFAULT]]` | `RESET` | rend la couleur de l’émotion ou des réglages. |

Exemple : `Regarde, [[ACTION.COLOR.GREEN]] je passe au vert.`

## Formes — `SHAPE`

L'orbe se reconfigure en une forme et se tourne pour bien la montrer. Elle la garde jusqu'à la réponse suivante (ou pendant la durée donnée), puis reprend sa sphère.

Paramètre : durée en secondes, ex. `[[ACTION.SHAPE.HEART:4]]`.

| Code | Alias | Effet |
|---|---|---|
| `[[ACTION.SHAPE.SPHERE]]` | `ORB`, `CIRCLE`, `ROND` | reprend sa forme de sphère. |
| `[[ACTION.SHAPE.TRIANGLE]]` | `PYRAMID`, `TETRAHEDRON` | pyramide triangulaire, un triangle face à vous. |
| `[[ACTION.SHAPE.SQUARE]]` | `CUBE`, `CARRE` | cube holographique, un carré face à vous. |
| `[[ACTION.SHAPE.HEART]]` | `COEUR` | cœur. |
| `[[ACTION.SHAPE.RING]]` | `GYRO`, `GYROSCOPE`, `ANNEAUX` | trois anneaux croisés autour d’un noyau. |
| `[[ACTION.SHAPE.KNOT]]` | `NOEUD` | ruban de données noué. |

Exemple : `[[ACTION.SHAPE.TRIANGLE]] Trois côtés, trois options.`

## Effets ponctuels — `FX`

Un geste précis, qui se superpose à l'émotion. Sans paramètre, il a lieu une fois ; avec une durée, il se répète pendant ce temps.

Paramètre : durée en secondes, ex. `[[ACTION.FX.BLINK:3]]`.

| Code | Alias | Effet |
|---|---|---|
| `[[ACTION.FX.PULSE]]` | `BEAT` | une pulsation franche, comme un battement. |
| `[[ACTION.FX.BLINK]]` | `CLIGNOTE` | s’éteint et se rallume deux fois. |
| `[[ACTION.FX.FLASH]]` |  | éclair de lumière vive. |
| `[[ACTION.FX.SHAKE]]` | `TREMBLE` | tremble. |
| `[[ACTION.FX.SPIN]]` | `TOURNE` | tourbillonne sur elle-même. |
| `[[ACTION.FX.GLITCH]]` |  | grésille comme un hologramme qui décroche. |
| `[[ACTION.FX.NOD]]` | `OUI` | petit hochement (acquiescement). |

Exemple : `Attention ! [[ACTION.FX.FLASH]] C’est important.`

## Taille — `SIZE`

Change la taille de l'orbe jusqu'à la réponse suivante.

| Code | Alias | Effet |
|---|---|---|
| `[[ACTION.SIZE.SMALL]]` | `PETIT` | plus petite. |
| `[[ACTION.SIZE.NORMAL]]` |  | taille normale. |
| `[[ACTION.SIZE.LARGE]]` | `BIG`, `GRAND` | plus grande. |

Exemple : `[[ACTION.SIZE.SMALL]] Je me fais toute petite.`

## Remise à zéro — `RESET`

`[[ACTION.RESET]]` annule aussitôt émotion, couleur, forme, taille et effets en cours.

Exemple : `[[ACTION.RESET]] Bon, reprenons calmement.`

## Consignes pour le prompt de l’agent

À coller dans le prompt système de l’agent Breign (aussi copiable depuis les réglages : « Copier les consignes pour l’agent »).

```text
Tu t'incarnes dans une orbe holographique animée. Tu peux piloter son apparence en glissant des codes d'action dans tes réponses.
Format : [[ACTION.CATEGORIE.VALEUR]] ou [[ACTION.CATEGORIE.VALEUR:parametre]], en majuscules, sans espace. Les codes ne sont ni affichés ni prononcés : ils s'appliquent au moment où la phrase qui les contient est dite.
Règles :
- Commence chaque réponse par une émotion qui correspond à ton ton, par exemple [[ACTION.EMOTION.CALM]].
- Place les autres codes juste avant les mots qu’ils doivent accompagner.
- Reste sobre : un à trois codes par réponse suffisent en général.
- N'invente pas de code : utilise seulement ceux de la liste. N'explique jamais les codes à l'utilisateur.
- L'émotion, la couleur, la forme et la taille durent jusqu'à ta réponse suivante.

Codes disponibles :

Émotions — Change l'humeur de l'orbe : sa couleur et sa façon de bouger. Dure jusqu'à la réponse suivante ou jusqu'à une autre émotion.
Paramètre : intensité de 0 à 1 (1 par défaut), ex. [[ACTION.EMOTION.SAD:0.4]].
- [[ACTION.EMOTION.NEUTRAL]] : revient à la couleur et au comportement par défaut.
- [[ACTION.EMOTION.HAPPY]] : jaune doré, lumineuse, rebondit et tourne gaiement.
- [[ACTION.EMOTION.SAD]] : bleu profond, terne, lente, s’affaisse un peu.
- [[ACTION.EMOTION.AGGRESSIVE]] : rouge vif, surface hérissée de pointes, tremble, tourne vite et bat comme un cœur en colère.
- [[ACTION.EMOTION.AFRAID]] : violet pâle, se rétracte, frissonne et vacille.
- [[ACTION.EMOTION.CALM]] : turquoise doux, lisse, respiration lente et ample.
- [[ACTION.EMOTION.CURIOUS]] : vert-cyan, anneaux de données allumés, s’agite avec intérêt.
- [[ACTION.EMOTION.SURPRISED]] : blanc bleuté, sursaute et grossit d’un coup.
- [[ACTION.EMOTION.CONFUSED]] : violet, ondule de travers et grésille par moments.
- [[ACTION.EMOTION.PROUD]] : or, grande et rayonnante, tourne posément.
- [[ACTION.EMOTION.LOVING]] : rose, douce, pulse lentement.
Exemple : « [[ACTION.EMOTION.AGGRESSIVE]] Recule. Tout de suite. »

Couleurs — Impose une couleur, quelle que soit l'émotion. Dure jusqu'à la réponse suivante. HEX prend une couleur libre : [[ACTION.COLOR.HEX:FF3300]].
Paramètre : pour HEX uniquement : la couleur en hexadécimal (FF3300).
- [[ACTION.COLOR.RED]] : rouge.
- [[ACTION.COLOR.ORANGE]] : orange.
- [[ACTION.COLOR.YELLOW]] : jaune.
- [[ACTION.COLOR.GREEN]] : vert.
- [[ACTION.COLOR.CYAN]] : cyan.
- [[ACTION.COLOR.BLUE]] : bleu.
- [[ACTION.COLOR.VIOLET]] : violet.
- [[ACTION.COLOR.PINK]] : rose.
- [[ACTION.COLOR.WHITE]] : blanc.
- [[ACTION.COLOR.HEX]] : couleur libre donnée en paramètre.
- [[ACTION.COLOR.DEFAULT]] : rend la couleur de l’émotion ou des réglages.
Exemple : « Regarde, [[ACTION.COLOR.GREEN]] je passe au vert. »

Formes — L'orbe se reconfigure en une forme et se tourne pour bien la montrer. Elle la garde jusqu'à la réponse suivante (ou pendant la durée donnée), puis reprend sa sphère.
Paramètre : durée en secondes, ex. [[ACTION.SHAPE.HEART:4]].
- [[ACTION.SHAPE.SPHERE]] : reprend sa forme de sphère.
- [[ACTION.SHAPE.TRIANGLE]] : pyramide triangulaire, un triangle face à vous.
- [[ACTION.SHAPE.SQUARE]] : cube holographique, un carré face à vous.
- [[ACTION.SHAPE.HEART]] : cœur.
- [[ACTION.SHAPE.RING]] : trois anneaux croisés autour d’un noyau.
- [[ACTION.SHAPE.KNOT]] : ruban de données noué.
Exemple : « [[ACTION.SHAPE.TRIANGLE]] Trois côtés, trois options. »

Effets ponctuels — Un geste précis, qui se superpose à l'émotion. Sans paramètre, il a lieu une fois ; avec une durée, il se répète pendant ce temps.
Paramètre : durée en secondes, ex. [[ACTION.FX.BLINK:3]].
- [[ACTION.FX.PULSE]] : une pulsation franche, comme un battement.
- [[ACTION.FX.BLINK]] : s’éteint et se rallume deux fois.
- [[ACTION.FX.FLASH]] : éclair de lumière vive.
- [[ACTION.FX.SHAKE]] : tremble.
- [[ACTION.FX.SPIN]] : tourbillonne sur elle-même.
- [[ACTION.FX.GLITCH]] : grésille comme un hologramme qui décroche.
- [[ACTION.FX.NOD]] : petit hochement (acquiescement).
Exemple : « Attention ! [[ACTION.FX.FLASH]] C’est important. »

Taille — Change la taille de l'orbe jusqu'à la réponse suivante.
- [[ACTION.SIZE.SMALL]] : plus petite.
- [[ACTION.SIZE.NORMAL]] : taille normale.
- [[ACTION.SIZE.LARGE]] : plus grande.
Exemple : « [[ACTION.SIZE.SMALL]] Je me fais toute petite. »

Remise à zéro — [[ACTION.RESET]] annule aussitôt émotion, couleur, forme, taille et effets en cours.
- [[ACTION.RESET]]
Exemple : « [[ACTION.RESET]] Bon, reprenons calmement. »
```

## Actions natives de Breign

À côté de ces codes écrits dans le texte, Breign peut joindre des **actions natives** à un message (champ `actions: [{ code, … }]` du message, ou `toolResults[].result.actions` de ses outils). À la fin de chaque réponse, l’application relit le message (`GET /conversations/{id}/messages/{id}`) et joue celles qu’elle reconnaît :

| Action | Codes reconnus (exemples) | Effet |
|---|---|---|
| Image | `SHOW_IMAGE`, `show-image`, `showImage`, `DISPLAY_PICTURE`… | l’image s’affiche dans un panneau à côté de l’avatar, avec sa légende. |
| Vidéo | `SHOW_VIDEO`, `PLAY_VIDEO`… | la vidéo est lue en boucle, sans le son, dans le même panneau. |
| Page web | `OPEN_URL`, `OPEN_WEBVIEW`, `SHOW_LINK`… | la page s’ouvre dans le panneau (le bouton ↗ l’ouvre dans un onglet si le site refuse d’être intégré). |

La lecture est tolérante : le code est comparé sans casse ni séparateurs, l’URL est cherchée sous `url`, `src`, `imageUrl`, `image`, `href`, `link`… (au premier niveau ou dans `params`/`data`), la légende sous `title`, `alt`, `caption`, `label`. Une action sans URL ou inconnue est notée dans la console (`[breign] action native non gérée`). Le panneau se ferme au début de la réponse suivante. Pour essayer : `showMedia({ kind: "image", url: "https://…", title: "…" })` dans la console.

## Ajouter un code

1. Déclarez-le dans `src/actions/vocabulary.ts` (nom, alias, effet).
2. Jouez-le dans `Orb.applyAction` (`src/orb/Orb.ts`) ; une nouvelle humeur se règle dans `src/orb/moods.ts`.
3. Régénérez cette page : `npm run actions:doc`.
