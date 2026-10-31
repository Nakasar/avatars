# Breign Avatars

Avatar 3D réaliste dans le navigateur (Three.js), connecté à la plateforme
[Breign](https://breign.eu) via le SDK [`@breign/client`](https://www.npmjs.com/package/@breign/client).

L'avatar écoute (micro ou texte), envoie le message à un agent Breign, puis répond de vive voix
avec un lipsync, des expressions et un regard vivants.

## Démarrage

```bash
npm install        # copie aussi le transcodeur Basis dans public/basis
npm run dev        # http://localhost:5173
```

Ouvrez les réglages (⚙) et renseignez :

| Réglage | Rôle |
| --- | --- |
| URL de l'API | `/breign-api` par défaut : proxy Vite vers `https://api.breign.eu` (évite le CORS en local). |
| Clé API | Clé personnelle (profil Breign → clés API), envoyée en en-tête `X-API-Key`. Stockée dans le navigateur. |
| Agent | Id de l'agent qui répond. Le bouton « Lister » interroge `GET /agents`. |
| Application | Optionnel : application (avatar) Breign. Active sa voix (`POST /apps/{id}/text-to-speech`) et sa transcription. Sans elle, la voix du navigateur est utilisée. |
| Langue | Langue de la conversation, de la voix et de la transcription. |
| Modèle 3D | URL d'un GLB (voir plus bas). |

Les mêmes valeurs peuvent venir de `.env.local` (voir `.env.example`) ou de l'URL :
`?agent=…&app=…&lang=fr&model=…&quality=high|medium|low`. La clé API n'est jamais lue depuis l'URL.

Le bouton « Tester la voix » des réglages fait parler l'avatar sans connexion à Breign.

## Architecture

```
src/
  main.ts                  assemblage : scène, avatar, voix, chat, micro, réglages
  settings.ts              réglages (env → navigateur → URL)
  scene/Stage.ts           rendu : tone mapping AgX, IBL, éclairage 3 points, ombres douces,
                           MSAA, GTAO, bloom léger, finition photo (vignettage, grain)
  avatar/Avatar.ts         chargement GLB (KTX2, meshopt, Draco), mise en pose, blendshapes,
                           clignements, saccades, respiration, mouvements de tête, expressions
  avatar/materials.ts      matériaux physiques : peau (diffusion sous-cutanée approchée, sheen),
                           cornée (clearcoat), dents, tissus, cheveux (alpha-to-coverage)
  avatar/lipsync.ts        lipsync audio (analyse spectrale) et textuel (graphèmes → visèmes)
  avatar/visemes.ts        visèmes Oculus et leur équivalent ARKit
  avatar/Voice.ts          file de phrases, synthèse Breign ou navigateur, enregistrement WAV
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

- La clé API est utilisée depuis le navigateur : à réserver au développement. En production,
  passer par un petit backend ou par les jetons d'instance éphémère des applications Breign.
- Le lipsync audio est une heuristique spectrale ; un lipsync fourni par Breign (visèmes
  horodatés), s'il est exposé, serait plus précis.
- En production, l'API doit autoriser l'origine du site (CORS) ou être servie derrière un proxy.
