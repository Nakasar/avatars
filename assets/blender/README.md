# Avatar humain modélisé dans Blender

`human.blend` est la source de `public/models/human.glb`. Tout est produit par les scripts de
`scripts/`, sans sculpture manuelle : on peut donc modifier un paramètre et tout régénérer.

## Régénérer

Avec Blender 5.2 (testé avec la 5.2.3 LTS) :

```bash
blender --background --factory-startup --python assets/blender/scripts/build_avatar.py -- --export
```

Il faut environ 12 minutes avec un GPU (cuisson Cycles et peinture de l'atlas 4K du visage). Le script écrit :

- `public/models/human.glb` (export glTF, textures WebP) ;
- `assets/blender/human.blend`, qui référence les textures de `assets/blender/textures/` ;
- les rendus de contrôle dans `assets/blender/renders/` (face, trois quarts, profil, expressions) ;
  `renders/avant/` garde ceux de la première version, `renders/comparatif/` les compare.

Sans `--export`, le script produit seulement des rendus de prévisualisation :
`build_avatar.py -- <préfixe>` ; ajoutez `--fast` pour des textures 4 fois plus petites (≈ 4 min).

## Pipeline

| Script | Rôle |
| --- | --- |
| `sdf.py`, `head_shape.py` | Forme de la tête : champ implicite construit à partir de mesures anthropométriques (loft de sections, crâne, nez, lèvres, orbites, paupières, pommettes, mâchoire, cou, trapèzes). |
| `topo.py`, `build_head.py` | Topologie en quads : sphère-cube densifiée vers le visage, boucles concentriques (orbiculaires) autour des yeux et de la bouche, projection sur le champ, relaxation sur la surface. |
| `build_body.py` | Épaisseur des paupières et cul-de-sac conjonctival, intérieur des lèvres et sac buccal, cou. |
| `parts.py` | Globes oculaires (iris aplati), cornées, caroncules, dents par type le long des arcades, gencives, langue, oreilles. |
| `hair.py` | Atlas de mèches (6 touffes de tons variés, poils isolés). Guides de mèches posés sur le crâne selon un champ de pousse, enregistrés en objet Hair Curves (`HairGuides` dans le .blend) puis convertis en cartes alpha ; sourcils et cils poil par poil. |
| `torso.py` | T-shirt à col rond posé sur un champ de torse. |
| `materials.py`, `textures.py`, `noise.py` | UV et matériaux PBR. La peau a deux atlas : `Face` (visage, 4096 px) et `Skin` (crâne, cou, oreilles, 2048 px). La position de chaque texel est cuite avec Cycles, puis la peau est peinte en numpy (zones jaune / rouge / bleue, rougeurs, capillaires, veines, taches, grains de beauté, barbe naissante, cuir chevelu, lèvres, intérieurs) ; normal map = rides et plis cuits depuis une copie haute résolution + micro-relief (pores, sillons de Voronoï) ; roughness contrastée (zone T, lèvres, joues). |
| `roles.py`, `rig.py`, `shapes.py` | Rôles anatomiques des sommets, squelette et poids, 52 shape keys ARKit et 15 visèmes (mêmes compositions que `src/avatar/visemes.ts`). |
| `studio.py` | Plateau de rendu (Cycles, éclairage trois points). |
| `foldcheck.py` | Contrôle : liste les faces retournées du maillage du visage. |

Repère des scripts : x vers la gauche du personnage, f vers l'avant, z vers le haut, en
mètres, avec pour origine le milieu des tragus. Dans Blender, y = −f.
