# Modèles 3D

| Fichier | Origine | Licence |
| --- | --- | --- |
| `mpfb.glb` | Avatar d'exemple du projet [TalkingHead](https://github.com/met4citizen/TalkingHead), créé avec Blender + [MPFB](https://static.makehumancommunity.org/mpfb.html) (écosystème MakeHuman). Optimisé ici avec `gltf-transform optimize` (textures WebP 2048 px, compression meshopt). | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |

Le modèle contient les 52 blendshapes ARKit, les 15 visèmes Oculus (`viseme_*`) et un squelette
(os `Head`, `LeftEye`, `RightEye`…), ce qu'il faut pour le lipsync et l'animation du visage.

Pour un rendu plus réaliste, remplacez-le par un GLB de meilleure qualité exposant les mêmes
blendshapes (Avaturn, Character Creator 4 + ARKit, export MetaHuman…), via les réglages ou
`VITE_AVATAR_MODEL_URL`. Vérifiez la licence du modèle avant de le versionner ou de le déployer.
