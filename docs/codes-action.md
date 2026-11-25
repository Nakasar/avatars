# Codes d’action de l’orbe

<!-- Fichier généré par `npm run actions:doc` depuis src/actions/vocabulary.ts : modifiez la source, pas ce fichier. -->

L’agent Breign peut piloter l’apparence de l’orbe en glissant des **codes d’action** dans ses réponses :

```
[ACTION.EMOTION.AGGRESSIVE] Recule. [ACTION.FX.PULSE] Tout de suite.
```

- C’est le format des **balises d’action de Breign** : avec une application, Breign les retire lui-même du texte et les envoie en `DO_ACTION` sur la web socket. Sans application, l’avatar les retire du texte affiché et prononcé. `[[ACTION.…]]` (doubles crochets) est aussi accepté.
- Chacun se déclenche au moment où la voix arrive à sa place dans la phrase (un code en début de réponse s’applique dès que l’orbe commence à parler).
- Format : `[ACTION.CATEGORIE.VALEUR]`, ou `[ACTION.CATEGORIE.VALEUR:paramètre]`. La casse, les accents et quelques alias français (`[ACTION.EMOTION.COLERE]`, `[ACTION.SHAPE.COEUR]`) sont tolérés. Un code inconnu est retiré du texte et ignoré.
- L’émotion, la couleur, la forme et la taille durent jusqu’à la **réponse suivante** (ou jusqu’à `[ACTION.RESET]`).
- Avec l’apparence humaine, seules les émotions proches d’une expression du visage sont jouées.

Pour essayer un code sans passer par l’agent : Réglages (⚙) → « Codes d’action » → Jouer, ou dans la console `actions("[ACTION.SHAPE.HEART]")`.

## Émotions — `EMOTION`

Change l'humeur de l'orbe : sa couleur et sa façon de bouger. Dure jusqu'à la réponse suivante ou jusqu'à une autre émotion.

Paramètre : intensité de 0 à 1 (1 par défaut), ex. `[ACTION.EMOTION.SAD:0.4]`.

| Code | Alias | Effet |
|---|---|---|
| `[ACTION.EMOTION.NEUTRAL]` | `NEUTRE` | revient à la couleur et au comportement par défaut. |
| `[ACTION.EMOTION.HAPPY]` | `JOY`, `JOYEUX`, `CONTENT` | jaune doré, lumineuse, rebondit et tourne gaiement. |
| `[ACTION.EMOTION.SAD]` | `TRISTE` | bleu profond, terne, lente, s’affaisse un peu. |
| `[ACTION.EMOTION.AGGRESSIVE]` | `ANGRY`, `ANGER`, `AGRESSIF`, `COLERE` | rouge vif, surface hérissée de pointes, tremble, tourne vite et bat comme un cœur en colère. |
| `[ACTION.EMOTION.AFRAID]` | `FEAR`, `SCARED`, `PEUR` | violet pâle, se rétracte, frissonne et vacille. |
| `[ACTION.EMOTION.CALM]` | `SERENE`, `CALME` | turquoise doux, lisse, respiration lente et ample. |
| `[ACTION.EMOTION.CURIOUS]` | `INTERESTED`, `CURIEUX` | vert-cyan, anneaux de données allumés, s’agite avec intérêt. |
| `[ACTION.EMOTION.SURPRISED]` | `SURPRIS` | blanc bleuté, sursaute et grossit d’un coup. |
| `[ACTION.EMOTION.CONFUSED]` | `PERPLEXED`, `PERPLEXE` | violet, ondule de travers et grésille par moments. |
| `[ACTION.EMOTION.PROUD]` | `CONFIDENT`, `FIER` | or, grande et rayonnante, tourne posément. |
| `[ACTION.EMOTION.LOVING]` | `TENDER`, `AFFECTION`, `TENDRE` | rose, douce, pulse lentement. |

Exemple : `[ACTION.EMOTION.AGGRESSIVE] Recule. Tout de suite.`

## Couleurs — `COLOR`

Impose une couleur, quelle que soit l'émotion. Dure jusqu'à la réponse suivante. `HEX` prend une couleur libre : `[ACTION.COLOR.HEX:FF3300]`.

Paramètre : pour `HEX` uniquement : la couleur en hexadécimal (`FF3300`).

| Code | Alias | Effet |
|---|---|---|
| `[ACTION.COLOR.RED]` | `ROUGE` | rouge. |
| `[ACTION.COLOR.ORANGE]` |  | orange. |
| `[ACTION.COLOR.YELLOW]` | `JAUNE` | jaune. |
| `[ACTION.COLOR.GREEN]` | `VERT` | vert. |
| `[ACTION.COLOR.CYAN]` |  | cyan. |
| `[ACTION.COLOR.BLUE]` | `BLEU` | bleu. |
| `[ACTION.COLOR.VIOLET]` | `PURPLE` | violet. |
| `[ACTION.COLOR.PINK]` | `ROSE` | rose. |
| `[ACTION.COLOR.WHITE]` | `BLANC` | blanc. |
| `[ACTION.COLOR.HEX]` |  | couleur libre donnée en paramètre. |
| `[ACTION.COLOR.DEFAULT]` | `RESET` | rend la couleur de l’émotion ou des réglages. |

Exemple : `Regarde, [ACTION.COLOR.GREEN] je passe au vert.`

## Formes — `SHAPE`

L'orbe se reconfigure en une forme et se tourne pour bien la montrer. Elle la garde jusqu'à la réponse suivante (ou pendant la durée donnée), puis reprend sa sphère.

Paramètre : durée en secondes, ex. `[ACTION.SHAPE.HEART:4]`.

| Code | Alias | Effet |
|---|---|---|
| `[ACTION.SHAPE.SPHERE]` | `ORB`, `CIRCLE`, `ROND` | reprend sa forme de sphère. |
| `[ACTION.SHAPE.TRIANGLE]` | `PYRAMID`, `TETRAHEDRON` | pyramide triangulaire, un triangle face à vous. |
| `[ACTION.SHAPE.SQUARE]` | `CUBE`, `CARRE` | cube holographique, un carré face à vous. |
| `[ACTION.SHAPE.HEART]` | `COEUR` | cœur. |
| `[ACTION.SHAPE.RING]` | `GYRO`, `GYROSCOPE`, `ANNEAUX` | trois anneaux croisés autour d’un noyau. |
| `[ACTION.SHAPE.KNOT]` | `NOEUD` | ruban de données noué. |

Exemple : `[ACTION.SHAPE.TRIANGLE] Trois côtés, trois options.`

## Effets ponctuels — `FX`

Un geste précis, qui se superpose à l'émotion. Sans paramètre, il a lieu une fois ; avec une durée, il se répète pendant ce temps.

Paramètre : durée en secondes, ex. `[ACTION.FX.BLINK:3]`.

| Code | Alias | Effet |
|---|---|---|
| `[ACTION.FX.PULSE]` | `BEAT` | une pulsation franche, comme un battement. |
| `[ACTION.FX.BLINK]` | `CLIGNOTE` | s’éteint et se rallume deux fois. |
| `[ACTION.FX.FLASH]` |  | éclair de lumière vive. |
| `[ACTION.FX.SHAKE]` | `TREMBLE` | tremble. |
| `[ACTION.FX.SPIN]` | `TOURNE` | tourbillonne sur elle-même. |
| `[ACTION.FX.GLITCH]` |  | grésille comme un hologramme qui décroche. |
| `[ACTION.FX.NOD]` | `OUI` | petit hochement (acquiescement). |

Exemple : `Attention ! [ACTION.FX.FLASH] C’est important.`

## Taille — `SIZE`

Change la taille de l'orbe jusqu'à la réponse suivante.

| Code | Alias | Effet |
|---|---|---|
| `[ACTION.SIZE.SMALL]` | `PETIT` | plus petite. |
| `[ACTION.SIZE.NORMAL]` |  | taille normale. |
| `[ACTION.SIZE.LARGE]` | `BIG`, `GRAND` | plus grande. |

Exemple : `[ACTION.SIZE.SMALL] Je me fais toute petite.`

## Remise à zéro — `RESET`

`[ACTION.RESET]` annule aussitôt émotion, couleur, forme, taille et effets en cours.

Exemple : `[ACTION.RESET] Bon, reprenons calmement.`

## Consignes pour le prompt de l’agent

À coller dans le prompt système de l’agent Breign (aussi copiable depuis les réglages : « Copier les consignes pour l’agent »).

```text
Tu t'incarnes dans une orbe holographique animée. Tu peux piloter son apparence en glissant des codes d'action dans tes réponses.
Format : [ACTION.CATEGORIE.VALEUR] ou [ACTION.CATEGORIE.VALEUR:parametre], en majuscules, sans espace. Ce sont des balises d'action : elles ne sont ni affichées ni prononcées, et s'appliquent au moment où la phrase qui les contient est dite.
Règles :
- Commence chaque réponse par une émotion qui correspond à ton ton, par exemple [ACTION.EMOTION.CALM].
- Place les autres codes juste avant les mots qu’ils doivent accompagner.
- Reste sobre : un à trois codes par réponse suffisent en général.
- N'invente pas de code : utilise seulement ceux de la liste. N'explique jamais les codes à l'utilisateur.
- L'émotion, la couleur, la forme et la taille durent jusqu'à ta réponse suivante.

Codes disponibles :

Émotions — Change l'humeur de l'orbe : sa couleur et sa façon de bouger. Dure jusqu'à la réponse suivante ou jusqu'à une autre émotion.
Paramètre : intensité de 0 à 1 (1 par défaut), ex. [ACTION.EMOTION.SAD:0.4].
- [ACTION.EMOTION.NEUTRAL] : revient à la couleur et au comportement par défaut.
- [ACTION.EMOTION.HAPPY] : jaune doré, lumineuse, rebondit et tourne gaiement.
- [ACTION.EMOTION.SAD] : bleu profond, terne, lente, s’affaisse un peu.
- [ACTION.EMOTION.AGGRESSIVE] : rouge vif, surface hérissée de pointes, tremble, tourne vite et bat comme un cœur en colère.
- [ACTION.EMOTION.AFRAID] : violet pâle, se rétracte, frissonne et vacille.
- [ACTION.EMOTION.CALM] : turquoise doux, lisse, respiration lente et ample.
- [ACTION.EMOTION.CURIOUS] : vert-cyan, anneaux de données allumés, s’agite avec intérêt.
- [ACTION.EMOTION.SURPRISED] : blanc bleuté, sursaute et grossit d’un coup.
- [ACTION.EMOTION.CONFUSED] : violet, ondule de travers et grésille par moments.
- [ACTION.EMOTION.PROUD] : or, grande et rayonnante, tourne posément.
- [ACTION.EMOTION.LOVING] : rose, douce, pulse lentement.
Exemple : « [ACTION.EMOTION.AGGRESSIVE] Recule. Tout de suite. »

Couleurs — Impose une couleur, quelle que soit l'émotion. Dure jusqu'à la réponse suivante. HEX prend une couleur libre : [ACTION.COLOR.HEX:FF3300].
Paramètre : pour HEX uniquement : la couleur en hexadécimal (FF3300).
- [ACTION.COLOR.RED] : rouge.
- [ACTION.COLOR.ORANGE] : orange.
- [ACTION.COLOR.YELLOW] : jaune.
- [ACTION.COLOR.GREEN] : vert.
- [ACTION.COLOR.CYAN] : cyan.
- [ACTION.COLOR.BLUE] : bleu.
- [ACTION.COLOR.VIOLET] : violet.
- [ACTION.COLOR.PINK] : rose.
- [ACTION.COLOR.WHITE] : blanc.
- [ACTION.COLOR.HEX] : couleur libre donnée en paramètre.
- [ACTION.COLOR.DEFAULT] : rend la couleur de l’émotion ou des réglages.
Exemple : « Regarde, [ACTION.COLOR.GREEN] je passe au vert. »

Formes — L'orbe se reconfigure en une forme et se tourne pour bien la montrer. Elle la garde jusqu'à la réponse suivante (ou pendant la durée donnée), puis reprend sa sphère.
Paramètre : durée en secondes, ex. [ACTION.SHAPE.HEART:4].
- [ACTION.SHAPE.SPHERE] : reprend sa forme de sphère.
- [ACTION.SHAPE.TRIANGLE] : pyramide triangulaire, un triangle face à vous.
- [ACTION.SHAPE.SQUARE] : cube holographique, un carré face à vous.
- [ACTION.SHAPE.HEART] : cœur.
- [ACTION.SHAPE.RING] : trois anneaux croisés autour d’un noyau.
- [ACTION.SHAPE.KNOT] : ruban de données noué.
Exemple : « [ACTION.SHAPE.TRIANGLE] Trois côtés, trois options. »

Effets ponctuels — Un geste précis, qui se superpose à l'émotion. Sans paramètre, il a lieu une fois ; avec une durée, il se répète pendant ce temps.
Paramètre : durée en secondes, ex. [ACTION.FX.BLINK:3].
- [ACTION.FX.PULSE] : une pulsation franche, comme un battement.
- [ACTION.FX.BLINK] : s’éteint et se rallume deux fois.
- [ACTION.FX.FLASH] : éclair de lumière vive.
- [ACTION.FX.SHAKE] : tremble.
- [ACTION.FX.SPIN] : tourbillonne sur elle-même.
- [ACTION.FX.GLITCH] : grésille comme un hologramme qui décroche.
- [ACTION.FX.NOD] : petit hochement (acquiescement).
Exemple : « Attention ! [ACTION.FX.FLASH] C’est important. »

Taille — Change la taille de l'orbe jusqu'à la réponse suivante.
- [ACTION.SIZE.SMALL] : plus petite.
- [ACTION.SIZE.NORMAL] : taille normale.
- [ACTION.SIZE.LARGE] : plus grande.
Exemple : « [ACTION.SIZE.SMALL] Je me fais toute petite. »

Remise à zéro — [ACTION.RESET] annule aussitôt émotion, couleur, forme, taille et effets en cours.
- [ACTION.RESET]
Exemple : « [ACTION.RESET] Bon, reprenons calmement. »
```

## Avec une application Breign : la web socket

Quand une **application** (avatar) est choisie dans les réglages, l’avatar suit l’intégration Breign à deux canaux :

- **Montant, API HTTP** : la question part par `POST /apps/{appId}/chats` (puis `/chats/{conversationId}`) avec `?instanceId=…` ; la voix de l’utilisateur est transcrite par `POST /apps/{appId}/speech-to-text` ; une interruption appelle `POST /apps/{appId}/interrupts` ; la fin de réponse renvoie le statut `IDLE`.
- **Descendant, web socket** : `wss://api.breign.eu/apps/{appId}/instances/{instanceId}/sockets` (ou `/apps/{appId}/sockets` sans instance). Authentification par `AUTHENTICATION_RESPONSE` avec le `authSecret` de l’app (lu dans `GET /agents/{agentId}/apps` avec le compte connecté) et `version: 2`, `PING` toutes les 25 s, reconnexion avec rejeu depuis le dernier `websocketMessageId`, jamais après `DISCONNECT` ou `AUTHENTICATION_FAILED`.

Messages joués :

| Message | Effet |
|---|---|
| `SAY` | phrase à dire, avec l’audio déjà synthétisé par Breign ; remises dans l’ordre des `sequence`, fin de réponse sur `final`. |
| `SAY_FILLER` | phrase d’attente, jouée si rien d’autre n’est à dire. |
| `DO_ACTION` | balise d’action de la réponse : `ACTION.EMOTION.AGGRESSIVE`, `ACTION.SHAPE.HEART`… pilotent l’orbe (voir plus haut) ; `PLAY_ANIMATION` au nom d’un effet ou d’une émotion aussi ; `APP_SHOW_PAGE` ouvre la page dans le panneau. Déclenchée quand la phrase de même `sequence` commence. |
| `SHOW_IMAGE` | l’image (`image.src`, `image.title`) s’affiche dans un panneau à côté de l’avatar, avec la phrase de même `sequence`. |
| `SHOW_SUGGESTIONS` | relances proposées sous les sous-titres ; un clic les envoie. |
| `INTERRUPT` | l’avatar se tait et ignore la suite du tour. |
| `INPUT` | question posée par un autre client (console d’opérateur) : affichée en sous-titre. |

Seules les phrases du tour en cours (`messageId` renvoyé par la requête) sont jouées. Tant que la socket n’est pas prête, la conversation passe par l’API des agents (synthèse phrase par phrase, actions relues sur le message une fois terminé).

**Une seule socket par instance** : un deuxième onglet sur la même instance déconnecte le premier. Donnez à chaque appareil sa propre instance (réglage « Instance de l’application », `VITE_BREIGN_INSTANCE_ID` ou `?instance=…`).

Pour essayer sans serveur, dans la console : `appSocketMessage({ type: "SHOW_IMAGE", messageId: "…", sequence: 0, image: { src: "https://…", title: "…" } })`, ou `showMedia({ kind: "image", url: "https://…", title: "…" })`.

## Ajouter un code

1. Déclarez-le dans `src/actions/vocabulary.ts` (nom, alias, effet).
2. Jouez-le dans `Orb.applyAction` (`src/orb/Orb.ts`) ; une nouvelle humeur se règle dans `src/orb/moods.ts`.
3. Régénérez cette page : `npm run actions:doc`.
