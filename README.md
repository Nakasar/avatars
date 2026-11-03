# Breign Avatars

Avatar 3D réaliste dans le navigateur (Three.js), connecté à la plateforme
[Breign](https://breign.eu) via le SDK [`@breign/client`](https://www.npmjs.com/package/@breign/client).

La conversation se fait à la voix, sans bouton : l'avatar écoute en continu, détecte quand vous
avez fini de parler, réfléchit (et en a l'air), puis répond de vive voix. Vous pouvez lui couper
la parole à tout moment.

## Démarrage

```bash
npm install        # copie aussi le transcodeur Basis dans public/basis
npm run dev        # http://127.0.0.1:5173
```

Cliquez sur « Se connecter avec Breign » : Breign App vous demande d'autoriser l'avatar, puis
vous ramène sur la page, connecté. Choisissez ensuite l'agent dans les réglages (⚙). Aucune clé
à copier.

### Connexion Breign (OAuth2)

La connexion suit le même chemin que `breign login` (CLI) : OAuth2 code d'autorisation avec
PKCE (S256) et retour sur une adresse loopback (RFC 8252), voir `src/breign/oauth.ts`.

1. `GET /auth/authorize?response_type=code&client_id=…&redirect_uri=http://127.0.0.1:5173/callback&code_challenge=…&state=…&device_name=…`
   redirige vers l'écran de consentement de Breign App ;
2. Breign App renvoie sur `/callback?code=…&state=…` (le `state` est vérifié, le code est aussitôt
   effacé de l'adresse) ;
3. `POST /auth/token` échange le code et le vérificateur PKCE contre une clé API de l'utilisateur,
   nommée « Breign Avatars (navigateur, système) » dans son profil.

« Se déconnecter » révoque cette clé (`DELETE /users/{userId}/api-keys/{keyId}`) et l'oublie.
Le client OAuth est `breign-cli` par défaut (celui de la CLI, déjà connu de la plateforme) ;
pour un écran de consentement au nom de l'avatar, enregistrez un client public dans
l'organisation (`POST /organizations/{id}/oauth-clients`, `type: public`,
`applicationType: native`) et renseignez `VITE_BREIGN_OAUTH_CLIENT_ID`. Le serveur de dev
écoute sur `127.0.0.1` ; ouverte sur `localhost`, la page y bascule d'elle-même avant la
connexion. Une clé API collée à la main reste possible (« Utiliser une clé API à la place »).

### Réglages

| Réglage | Rôle |
| --- | --- |
| URL de l'API | `/breign-api` par défaut : proxy Vite vers `https://api.breign.eu` (évite le CORS en local). |
| Compte Breign | « Se connecter avec Breign » (OAuth2), ou une clé API collée à la main. La clé est envoyée en en-tête `X-API-Key` et stockée dans ce navigateur. |
| Agent | Id de l'agent qui répond. Le bouton « Lister » interroge `GET /agents`. |
| Application | Optionnel : application (avatar) Breign. Active sa voix (`POST /apps/{id}/text-to-speech`) et sa transcription. Sans elle, la voix du navigateur est utilisée. |
| Langue | Langue de la conversation, de la voix et de la transcription. |
| Apparence du bot | « Humain réaliste » (le modèle 3D) ou « Orbe IA (mascotte) ». L'aperçu change en direct. |
| Couleur de l'orbe | Bleu, orange, vert ou violet. |
| Modèle 3D | URL d'un GLB (voir plus bas), pour l'apparence humaine. |

Les mêmes valeurs peuvent venir de `.env.local` (voir `.env.example`) ou de l'URL :
`?agent=…&app=…&lang=fr&model=…&look=human|orb&color=blue|orange|green|violet&quality=high|medium|low`. La clé API n'est jamais lue depuis l'URL.

Le bouton « Tester la voix » des réglages fait parler l'avatar sans connexion à Breign.

### Orbe IA

Une sphère holographique de données : nuée de particules, réseau de circuits qui scintille,
anneaux de données en pointillés, éclats de verre en orbite, étincelles et bribes de binaire
autour d'un cœur lumineux. Elle flotte, respire et réagit à la conversation :

| État | Réaction |
| --- | --- |
| Repos | Respiration lente, rotation, et de temps en temps une reconfiguration (gyroscope, cube, nœud) avant de redevenir sphère. |
| Écoute | Se resserre, respire plus vite et vibre au rythme de la voix de l'utilisateur. |
| Réflexion | Anneaux et données s'allument, tourbillon, cœur qui scintille, changements de forme en boucle. |
| Parole | Cœur, surface et étincelles pulsent avec l'énergie de la voix ; les éclats s'écartent. |

Les expressions se traduisent aussi : joie (plus vive, rebond), surprise (sursaut), tristesse
(plus terne, plus lente). Tout est procédural (`src/orb/Orb.ts`), sans fichier à charger.

### Codes d'action : l'agent pilote l'orbe

L'agent peut glisser des codes dans ses réponses pour changer l'émotion, la couleur ou la
forme de l'orbe, ou déclencher un effet précis :

```
[[ACTION.EMOTION.AGGRESSIVE]] Recule. [[ACTION.FX.PULSE]] Tout de suite.
[[ACTION.SHAPE.TRIANGLE]] Trois options. [[ACTION.SHAPE.SQUARE]] Quatre côtés.
[[ACTION.COLOR.HEX:FF3300]] [[ACTION.FX.BLINK:3]] [[ACTION.SIZE.LARGE]] [[ACTION.RESET]]
```

Les codes sont retirés des sous-titres et de la voix, et se déclenchent au moment où la voix
arrive à leur place. Émotions (neutre, joie, tristesse, colère, peur, calme, curiosité,
surprise, perplexité, fierté, tendresse), couleurs, formes (sphère, triangle, carré, cœur,
anneaux, nœud), effets (pulsation, clignement, éclair, tremblement, tourbillon, grésillement,
hochement) et taille. La liste complète et les consignes à coller dans le prompt de l'agent
sont dans [docs/codes-action.md](docs/codes-action.md) ; les réglages permettent de tester un
code et de copier ces consignes.

Les **actions natives** de Breign (par exemple montrer une image) sont aussi jouées : à la fin
de chaque réponse, l'application relit le message et affiche l'image, la vidéo ou la page web
qu'il porte dans un panneau à côté de l'avatar (`src/breign/nativeActions.ts`).

## Conversation vocale

Un premier geste (« Commencer la conversation ») autorise le micro et le son, puis plus aucun
bouton n'est nécessaire :

- **Détection de la voix** (`conversation/VoiceActivity.ts`) : niveau mesuré par trames de 20 ms
  face à un bruit de fond estimé en continu. La parole démarre après 160 ms de voix, avec 400 ms
  de pré-écoute pour ne pas couper la première syllabe, et le tour se termine après 750 ms de
  silence. Une courte pause au milieu d'une phrase ne coupe donc pas le tour.
- **Interruption** : si vous parlez pendant que l'avatar parle, il se tait aussitôt et vous
  écoute. Pendant qu'il parle, le seuil est relevé (+9 dB, 320 ms) pour que l'écho résiduel ne
  le coupe pas lui-même (l'annulation d'écho du navigateur est activée).
- **Phrase reprise** : si vous reprenez la parole pendant qu'il réfléchit, la réponse en cours
  est abandonnée et votre nouvelle phrase est ajoutée à la précédente.
- **Attitudes** (`Avatar.setMode`) :
  - écoute : penché vers vous, regard sur vos yeux, sourcils qui réagissent à votre voix, hochement de tête à la fin de votre phrase ;
  - réflexion : regard détourné vers le haut sur le côté, tête inclinée, sourcil froncé, lèvres qui se pincent, clignements plus lents ;
  - parole : regard qui s'échappe brièvement de temps en temps.
- Sous-titres de la conversation et témoin d'état en bas de l'écran. `/` ouvre une saisie au
  clavier, `Échap` coupe l'avatar.

## Architecture

```
src/
  main.ts                  assemblage : scène, avatar, conversation, sous-titres, réglages
  conversation/
    Conversation.ts        tours de parole, interruptions, état de l'avatar
    VoiceActivity.ts       écoute continue du micro, détection de voix, WAV 16 kHz
  settings.ts              réglages (env → navigateur → URL)
  scene/Stage.ts           rendu : tone mapping AgX, IBL, éclairage 3 points, ombres douces,
                           MSAA, GTAO, bloom léger, finition photo (vignettage, grain)
  avatar/Character.ts      interface commune aux apparences (humain, orbe)
  orb/Orb.ts               orbe IA : particules et shaders, formes, réactions aux états
  orb/moods.ts             humeurs, couleurs, formes et tailles des codes d'action
  actions/vocabulary.ts    vocabulaire des codes d'action (source de docs/codes-action.md)
  actions/parse.ts         repérage et retrait des codes dans le texte, même en streaming
  breign/nativeActions.ts  actions natives des messages Breign (image, vidéo, page web)
  avatar/Avatar.ts         chargement GLB (KTX2, meshopt, Draco), mise en pose, blendshapes,
                           clignements, saccades, respiration, mouvements de tête, expressions
  avatar/materials.ts      matériaux physiques : peau (diffusion sous-cutanée approchée, sheen),
                           cornée (clearcoat), dents, tissus, cheveux (alpha-to-coverage)
  avatar/lipsync.ts        lipsync audio (analyse spectrale) et textuel (graphèmes → visèmes)
  avatar/visemes.ts        visèmes Oculus et leur équivalent ARKit
  avatar/Voice.ts          file de phrases, synthèse Breign ou navigateur
  breign/BreignService.ts  appels Breign via @breign/client
```

### Dialogue avec Breign

Le dialogue reprend le fonctionnement de la CLI `breign chat` :

1. premier message : `POST /agents/{agentId}/prompts?async=true` (`PromptsApi.createPrompt`),
   puis `POST /conversations/{id}/prompts?async=true` pour la suite ;
2. suivi : `GET /conversations/{id}/messages/{messageId}/status` (`getMessageStatus`), dont le
   `content` grandit pendant la génération (`generating`, `toolCalling`… → `completed`,
   `failed` ou `moderated`) ;
3. chaque phrase complète part aussitôt en synthèse vocale : l'avatar commence à parler avant la
   fin de la génération.

La transcription du micro passe par `convertAppSpeechToText` (ou `convertAgentSpeechToText`
sans application), avec un WAV PCM 16 kHz encodé dans le navigateur.

## Modèle 3D

Le modèle par défaut (`public/models/mpfb.glb`, CC0, voir `public/models/README.md`) est un
personnage MakeHuman avec les 52 blendshapes ARKit et les 15 visèmes Oculus.

N'importe quel GLB exposant ces blendshapes fonctionne : les noms `eyeBlink_L`,
`eyeBlinkLeft` et `Eye_Blink_L` sont reconnus, ainsi que `viseme_aa`, `viseme_PP`… Les os
`Head`, `LeftEye`, `RightEye`, `LeftArm`… sont utilisés s'ils existent. Pour aller plus loin
dans le réalisme, les meilleures sources sont Avaturn (avatar depuis une photo), Character
Creator 4 (profil ARKit) ou un MetaHuman exporté en glTF. Pensez à optimiser le fichier :

```bash
npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 2048 --simplify false
```

## Limites connues

- La clé obtenue à la connexion est une clé API complète de l'utilisateur, gardée dans le
  navigateur. Pour un avatar public, passer plutôt par un petit backend ou par les jetons
  d'instance éphémère des applications Breign.
- Le retour de connexion doit être une adresse loopback (`127.0.0.1:<port>`) : l'avatar servi
  depuis un vrai domaine demandera un client OAuth « web » côté Breign.
- Le lipsync audio est une heuristique spectrale ; un lipsync fourni par Breign (visèmes
  horodatés), s'il est exposé, serait plus précis.
- En production, l'API doit autoriser l'origine du site (CORS) ou être servie derrière un proxy.
- Une réponse interrompue reste dans l'historique de la conversation côté Breign (la génération
  n'est pas annulée sur le serveur, seulement ignorée).
- La détection de voix se base sur l'énergie : dans une pièce très bruyante, un modèle de VAD
  neuronal (Silero) serait plus fiable. Les seuils sont réglables dans `DEFAULT_VAD`.
