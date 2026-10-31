// Copie le transcodeur Basis (textures KTX2 des modèles glTF) dans public/basis.
// Lancé automatiquement après `npm install`, relançable avec `npm run setup`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const basisSrc = join(root, 'node_modules/three/examples/jsm/libs/basis');
const basisDst = join(root, 'public/basis');
mkdirSync(basisDst, { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  copyFileSync(join(basisSrc, f), join(basisDst, f));
}
console.log('✓ transcodeur Basis copié dans public/basis');
