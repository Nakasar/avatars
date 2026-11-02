# Modèles 3D

| Fichier | Origine | Licence |
| --- | --- | --- |
| `human.glb` | **Modèle par défaut.** Buste masculin modélisé dans Blender 5.2 par scripts Python (`assets/blender/`), entièrement procédural : forme anatomique, topologie en quads, textures cuites, squelette et shape keys générés. | Propriété du projet |
| `mpfb.glb` | Ancien avatar d'exemple du projet [TalkingHead](https://github.com/met4citizen/TalkingHead), créé avec Blender + [MPFB](https://static.makehumancommunity.org/mpfb.html) (écosystème MakeHuman). Optimisé ici avec `gltf-transform optimize` (textures WebP 2048 px, compression meshopt). | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |

## `human.glb`

- Environ 46 000 triangles : peau (tête, cou, oreilles) 18 800, cheveux en cartes alpha 13 000,
  t-shirt 3 600, sourcils et cils poil par poil 4 000, puis yeux, cornées, caroncules, dents,
  gencives et langue.
- 67 shape keys : les 52 blendshapes ARKit (`eyeBlinkLeft`, `jawOpen`, `mouthSmileLeft`…) et les
  15 visèmes Oculus (`viseme_sil` … `viseme_U`) sur la peau. Les dents du bas, la langue, les cils
  et les sourcils portent, sous les mêmes noms, les shape keys qui les déplacent et suivent la peau.
- Squelette : `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftEye`, `RightEye`, `Jaw`.
  Les globes oculaires sont pondérés à 100 % sur leurs os.
- Matériaux PBR, textures WebP : visage 4096 px et reste de la peau 2048 px (couleur, normal
  map, occlusion/roughness), yeux, atlas de mèches, t-shirt. La diffusion sous-cutanée est ajoutée par l'application
  (`src/avatar/materials.ts`).
- Le personnage regarde vers +Z, à l'échelle 1 unité = 1 m (yeux à environ 1,62 m).

Pour le régénérer ou le modifier, voir `assets/blender/README.md`.

Pour aller plus loin en réalisme, remplacez-le par un GLB exposant les mêmes blendshapes
(Avaturn, Character Creator 4 + ARKit, export MetaHuman…), via les réglages ou
`VITE_AVATAR_MODEL_URL`. Vérifiez la licence du modèle avant de le versionner ou de le déployer.
