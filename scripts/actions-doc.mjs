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
  '[ACTION.EMOTION.AGGRESSIVE] Recule. [ACTION.FX.PULSE] Tout de suite.',
  '```',
  '',
  '- C’est le format des **balises d’action de Breign** : avec une application, Breign les retire lui-même du texte et les envoie en `DO_ACTION` sur la web socket. Sans application, l’avatar les retire du texte affiché et prononcé. `[[ACTION.…]]` (doubles crochets) est aussi accepté.',
  '- Chacun se déclenche au moment où la voix arrive à sa place dans la phrase (un code en début de réponse s’applique dès que l’orbe commence à parler).',
  '- Format : `[ACTION.CATEGORIE.VALEUR]`, ou `[ACTION.CATEGORIE.VALEUR:paramètre]`. La casse, les accents et quelques alias français (`[ACTION.EMOTION.COLERE]`, `[ACTION.SHAPE.COEUR]`) sont tolérés. Un code inconnu est retiré du texte et ignoré.',
  '- L’émotion, la couleur, la forme et la taille durent jusqu’à la **réponse suivante** (ou jusqu’à `[ACTION.RESET]`).',
  '- Avec l’apparence humaine, seules les émotions proches d’une expression du visage sont jouées.',
  '',
  'Pour essayer un code sans passer par l’agent : Réglages (⚙) → « Codes d’action » → Jouer, ou dans la console `actions("[ACTION.SHAPE.HEART]")`.',
  '',
];
for (const c of ACTION_CATEGORIES) {
  out.push(`## ${c.title} — \`${c.name}\``, '', c.about, '');
  if (c.param) out.push(`Paramètre : ${c.param}.`, '');
  if (c.values.length) {
    out.push('| Code | Alias | Effet |', '|---|---|---|');
    for (const v of c.values) {
      out.push(`| \`[ACTION.${c.name}.${v.name}]\` | ${(v.aliases ?? []).map((a) => `\`${a}\``).join(', ')} | ${v.effect} |`);
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
  '## Avec une application Breign : la web socket',
  '',
  'Quand une **application** (avatar) est choisie dans les réglages, l’avatar suit l’intégration Breign à deux canaux :',
  '',
  '- **Montant, API HTTP** : la question part par `POST /apps/{appId}/chats` (puis `/chats/{conversationId}`) avec `?instanceId=…` ; la voix de l’utilisateur est transcrite par `POST /apps/{appId}/speech-to-text` ; une interruption appelle `POST /apps/{appId}/interrupts` ; la fin de réponse renvoie le statut `IDLE`.',
  '- **Descendant, web socket** : `wss://api.breign.eu/apps/{appId}/instances/{instanceId}/sockets` (ou `/apps/{appId}/sockets` sans instance). Authentification par `AUTHENTICATION_RESPONSE` avec le `authSecret` de l’app (lu dans `GET /agents/{agentId}/apps` avec le compte connecté) et `version: 2`, `PING` toutes les 25 s, reconnexion avec rejeu depuis le dernier `websocketMessageId`, jamais après `DISCONNECT` ou `AUTHENTICATION_FAILED`.',
  '',
  'Messages joués :',
  '',
  '| Message | Effet |',
  '|---|---|',
  '| `SAY` | phrase à dire, avec l’audio déjà synthétisé par Breign ; remises dans l’ordre des `sequence`, fin de réponse sur `final`. |',
  '| `SAY_FILLER` | phrase d’attente, jouée si rien d’autre n’est à dire. |',
  '| `DO_ACTION` | balise d’action de la réponse : `ACTION.EMOTION.AGGRESSIVE`, `ACTION.SHAPE.HEART`… pilotent l’orbe (voir plus haut) ; `PLAY_ANIMATION` au nom d’un effet ou d’une émotion aussi ; `APP_SHOW_PAGE` ouvre la page dans le panneau. Déclenchée quand la phrase de même `sequence` commence. |',
  '| `SHOW_IMAGE` | l’image (`image.src`, `image.title`) s’affiche dans un panneau à côté de l’avatar, avec la phrase de même `sequence`. |',
  '| `SHOW_SUGGESTIONS` | relances proposées sous les sous-titres ; un clic les envoie. |',
  '| `INTERRUPT` | l’avatar se tait et ignore la suite du tour. |',
  '| `INPUT` | question posée par un autre client (console d’opérateur) : affichée en sous-titre. |',
  '',
  'Seules les phrases du tour en cours (`messageId` renvoyé par la requête) sont jouées. Tant que la socket n’est pas prête, la conversation passe par l’API des agents (synthèse phrase par phrase, actions relues sur le message une fois terminé).',
  '',
  '**Une seule socket par instance** : un deuxième onglet sur la même instance déconnecte le premier. Donnez à chaque appareil sa propre instance (réglage « Instance de l’application », `VITE_BREIGN_INSTANCE_ID` ou `?instance=…`).',
  '',
  'Pour essayer sans serveur, dans la console : `appSocketMessage({ type: "SHOW_IMAGE", messageId: "…", sequence: 0, image: { src: "https://…", title: "…" } })`, ou `showMedia({ kind: "image", url: "https://…", title: "…" })`.',
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
