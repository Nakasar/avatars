// Génère docs/codes-action.md depuis src/actions/vocabulary.ts (Node ≥ 22.18 lit le TypeScript).
import { writeFileSync } from 'node:fs';
import { ACTION_CATEGORIES, actionPrompt } from '../src/actions/vocabulary.ts';

const out = [
  '# Codes d’action de l’orbe',
  '',
  '<!-- Fichier généré par `npm run actions:doc` depuis src/actions/vocabulary.ts : modifiez la source, pas ce fichier. -->',
  '',
  'L’agent Breign peut piloter l’apparence de l’orbe en glissant des **codes d’action** dans ses réponses :',
  '',
  '```',
  '[[ACTION.EMOTION.AGGRESSIVE]] Recule. [[ACTION.FX.PULSE]] Tout de suite.',
  '```',
  '',
  '- Les codes sont **retirés** du texte affiché et ne sont **pas prononcés**.',
  '- Chacun se déclenche au moment où la voix arrive à sa place dans la phrase (un code en début de réponse s’applique dès que l’orbe commence à parler).',
  '- Format : `[[ACTION.CATEGORIE.VALEUR]]`, ou `[[ACTION.CATEGORIE.VALEUR:paramètre]]`. La casse, les accents et quelques alias français (`[[ACTION.EMOTION.COLERE]]`, `[[ACTION.SHAPE.COEUR]]`) sont tolérés. Un code inconnu est retiré du texte et ignoré.',
  '- L’émotion, la couleur, la forme et la taille durent jusqu’à la **réponse suivante** (ou jusqu’à `[[ACTION.RESET]]`).',
  '- Avec l’apparence humaine, seules les émotions proches d’une expression du visage sont jouées.',
  '',
  'Pour essayer un code sans passer par l’agent : Réglages (⚙) → « Codes d’action » → Jouer, ou dans la console `actions("[[ACTION.SHAPE.HEART]]")`.',
  '',
];
for (const c of ACTION_CATEGORIES) {
  out.push(`## ${c.title} — \`${c.name}\``, '', c.about, '');
  if (c.param) out.push(`Paramètre : ${c.param}.`, '');
  if (c.values.length) {
    out.push('| Code | Alias | Effet |', '|---|---|---|');
    for (const v of c.values) {
      out.push(`| \`[[ACTION.${c.name}.${v.name}]]\` | ${(v.aliases ?? []).map((a) => `\`${a}\``).join(', ')} | ${v.effect} |`);
    }
    out.push('');
  }
  out.push(`Exemple : \`${c.example}\``, '');
}
out.push(
  '## Consignes pour le prompt de l’agent',
  '',
  'À coller dans le prompt système de l’agent Breign (aussi copiable depuis les réglages : « Copier les consignes pour l’agent »).',
  '',
  '```text',
  actionPrompt(),
  '```',
  '',
  '## Actions natives de Breign',
  '',
  'À côté de ces codes écrits dans le texte, Breign peut joindre des **actions natives** à un message (champ `actions: [{ code, … }]` du message, ou `toolResults[].result.actions` de ses outils). À la fin de chaque réponse, l’application relit le message (`GET /conversations/{id}/messages/{id}`) et joue celles qu’elle reconnaît :',
  '',
  '| Action | Codes reconnus (exemples) | Effet |',
  '|---|---|---|',
  '| Image | `SHOW_IMAGE`, `show-image`, `showImage`, `DISPLAY_PICTURE`… | l’image s’affiche dans un panneau à côté de l’avatar, avec sa légende. |',
  '| Vidéo | `SHOW_VIDEO`, `PLAY_VIDEO`… | la vidéo est lue en boucle, sans le son, dans le même panneau. |',
  '| Page web | `OPEN_URL`, `OPEN_WEBVIEW`, `SHOW_LINK`… | la page s’ouvre dans le panneau (le bouton ↗ l’ouvre dans un onglet si le site refuse d’être intégré). |',
  '',
  'Les avatars Breign reçoivent aussi ces actions sur la **web socket de l’application**, sous forme de messages typés (`SAY` pour dire un texte, `SHOW_IMAGE` pour montrer une image) :',
  '',
  '```json',
  '{ "type": "SHOW_IMAGE", "messageId": "…", "sequence": 0, "text": "An image", "image": { "title": "An image", "src": "https://…" } }',
  '```',
  '',
  'Renseignez son URL dans les réglages (« Web socket de l’application », ou `VITE_BREIGN_SOCKET_URL`) : `{appId}` et `{apiKey}` y sont remplacés. Les `SAY` y sont ignorés, la réponse parlée étant déjà suivie par l’API. Pour essayer sans connexion : `appSocketMessage({ type: "SHOW_IMAGE", image: { src: "https://…", title: "…" } })` dans la console.',
  '',
  'La lecture est tolérante : le code est comparé sans casse ni séparateurs, l’URL est cherchée sous `url`, `src`, `imageUrl`, `image`, `href`, `link`… (au premier niveau ou dans `params`/`data`), la légende sous `title`, `alt`, `caption`, `label`. Une action sans URL ou inconnue est notée dans la console (`[breign] action native non gérée`). Le panneau se ferme au début de la réponse suivante. Pour essayer : `showMedia({ kind: "image", url: "https://…", title: "…" })` dans la console.',
  '',
  '## Ajouter un code',
  '',
  '1. Déclarez-le dans `src/actions/vocabulary.ts` (nom, alias, effet).',
  '2. Jouez-le dans `Orb.applyAction` (`src/orb/Orb.ts`) ; une nouvelle humeur se règle dans `src/orb/moods.ts`.',
  '3. Régénérez cette page : `npm run actions:doc`.',
  '',
);
writeFileSync(new URL('../docs/codes-action.md', import.meta.url), out.join('\n'));
console.log('docs/codes-action.md généré');
