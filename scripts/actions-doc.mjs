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
  '## Ajouter un code',
  '',
  '1. Déclarez-le dans `src/actions/vocabulary.ts` (nom, alias, effet).',
  '2. Jouez-le dans `Orb.applyAction` (`src/orb/Orb.ts`) ; une nouvelle humeur se règle dans `src/orb/moods.ts`.',
  '3. Régénérez cette page : `npm run actions:doc`.',
  '',
);
writeFileSync(new URL('../docs/codes-action.md', import.meta.url), out.join('\n'));
console.log('docs/codes-action.md généré');
