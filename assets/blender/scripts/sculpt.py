"""Passe de sculpture : coups de pinceau placés à la main sur des repères anatomiques.

Chaque coup est un décalage de surface (m, positif = gonfle, négatif = creuse) ajouté au
champ de la tête : la surface sculptée est donc celle que suivent la topologie, les poils,
les cuissons et les shape keys. Repère anatomique (voir sdf.py).

Types de pinceaux :
- « blob »  : gonfle / creuse une région ellipsoïdale (falloff lisse) ;
- « line »  : arête (> 0) ou pli (< 0) le long d'une polyligne, effilé aux extrémités.
Les coups marqués sym=True sont appliqués aux deux côtés (miroir en x).
"""
import numpy as np

import head_shape as hs

MOUTH_Z = hs.MOUTH_Z
W = hs.MOUTH_W


def _upper_lip_border(n=13):
    x = np.linspace(-W * 0.92, W * 0.92, n)
    u = np.abs(x) / (W * 1.02)
    z = (MOUTH_Z + 0.0010 * (1 - u * u) + 0.0074 * (1 - u ** 2.2) ** 0.75
         + 0.0010 * np.exp(-((np.abs(x) - 0.0058) / 0.0035) ** 2) - 0.0009 * np.exp(-(x / 0.0025) ** 2))
    f = 0.1015 - 26.0 * x * x
    return np.stack([x, f, z], 1)


STROKES = [
    # --- front, arcades, glabelle ----------------------------------------------------
    dict(kind="line", pts=[(0.008, 0.0975, 0.0345), (0.028, 0.0915, 0.0410), (0.047, 0.0800, 0.0400)],
         r=0.0060, a=0.0010, sym=True),                                   # arcade sourcilière
    dict(kind="blob", c=(0.0, 0.0995, 0.0340), r=(0.009, 0.010, 0.006), a=0.0006),     # glabelle
    dict(kind="blob", c=(0.0, 0.0945, 0.0255), r=(0.006, 0.010, 0.004), a=-0.0006),    # nasion
    dict(kind="blob", c=(0.022, 0.0920, 0.0720), r=(0.018, 0.020, 0.016), a=0.0008, sym=True),  # bosses frontales
    dict(kind="blob", c=(0.068, 0.0500, 0.0400), r=(0.010, 0.020, 0.016), a=-0.0012, sym=True), # tempes
    # --- pommettes, joues ---------------------------------------------------------------
    dict(kind="blob", c=(0.052, 0.0590, 0.0060), r=(0.013, 0.015, 0.010), a=0.0012, sym=True),  # zygomatique
    dict(kind="blob", c=(0.053, 0.0540, -0.0290), r=(0.012, 0.020, 0.012), a=-0.0012, sym=True),# creux sous-malaire
    dict(kind="line", pts=[(0.0215, 0.0930, -0.0160), (0.0280, 0.0920, -0.0320), (0.0335, 0.0870, -0.0500)],
         r=0.0025, a=-0.0005, sym=True),                                  # sillon naso-génien
    dict(kind="line", pts=[(0.0265, 0.0900, -0.0160), (0.0335, 0.0880, -0.0320), (0.0385, 0.0830, -0.0480)],
         r=0.0050, a=0.0006, sym=True),                                   # bourrelet de joue
    # --- yeux ------------------------------------------------------------------------------
    # (pli palpébral et bourrelet prétarsal : sculptés en détail au pinceau, multirésolution)
    dict(kind="line", pts=[(0.0200, 0.0840, 0.0120), (0.0300, 0.0830, 0.0060)],
         r=0.0025, a=-0.0004, sym=True),                                  # vallée des larmes
    # --- nez, lèvres ------------------------------------------------------------------------
    dict(kind="line", pts=[(0.0040, 0.1000, -0.0400), (0.0036, 0.0995, -0.0250)],
         r=0.0013, a=0.0003, sym=True),                                   # colonnes du philtre
    dict(kind="line", pts=_upper_lip_border(), r=0.0012, a=0.00025),     # liseré du vermillon
    dict(kind="line", pts=[(-0.012, 0.0930, -0.0605), (0.0, 0.0935, -0.0610), (0.012, 0.0930, -0.0605)],
         r=0.0040, a=-0.0006),                                            # ombre sous la lèvre inférieure
    # --- menton, mâchoire, cou ---------------------------------------------------------------
    dict(kind="blob", c=(0.0, 0.0940, -0.0740), r=(0.010, 0.010, 0.008), a=0.0007),    # houppe du menton
    dict(kind="line", pts=[(0.053, 0.000, -0.0590), (0.040, 0.045, -0.0740), (0.025, 0.078, -0.0860)],
         r=0.0040, a=0.0007, sym=True),                                   # bord mandibulaire
    dict(kind="line", pts=[(0.050, 0.000, -0.0660), (0.036, 0.045, -0.0800), (0.022, 0.070, -0.0920)],
         r=0.0050, a=-0.0006, sym=True),                                  # sous la mandibule
    dict(kind="blob", c=(0.055, 0.0250, -0.0350), r=(0.010, 0.018, 0.016), a=0.0008, sym=True),  # masséter
    dict(kind="line", pts=[(0.060, -0.025, -0.030), (0.040, 0.010, -0.090), (0.014, 0.045, -0.160)],
         r=0.0080, a=0.0018, sym=True),                                   # sterno-cléido-mastoïdien
    dict(kind="blob", c=(0.0, 0.0480, -0.1150), r=(0.008, 0.008, 0.012), a=0.0025),    # pomme d'Adam
    # --- légères asymétries (un visage réel n'est jamais symétrique) ------------------------
    dict(kind="blob", c=(-0.046, 0.0700, -0.0100), r=(0.016, 0.02, 0.016), a=0.0005),  # joue droite plus pleine
    dict(kind="blob", c=(0.0020, 0.1100, -0.0140), r=(0.004, 0.006, 0.005), a=0.0003), # pointe du nez déviée
    dict(kind="blob", c=(0.036, 0.0880, 0.0420), r=(0.012, 0.02, 0.006), a=0.0004),    # sourcil gauche plus haut
]


def _blob(p, c, r, a):
    q = (p - np.asarray(c)) / np.asarray(r)
    d2 = np.sum(q * q, -1)
    return a * np.clip(1 - d2, 0, 1) ** 2


def _line(p, pts, r, a):
    pts = np.asarray(pts, float)
    best = np.full(p.shape[:-1], np.inf)
    tpos = np.zeros(p.shape[:-1])
    seg_len = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    total = seg_len.sum()
    acc = 0.0
    for i in range(len(pts) - 1):
        a0, b0 = pts[i], pts[i + 1]
        ab = b0 - a0
        t = np.clip(np.sum((p - a0) * ab, -1) / np.dot(ab, ab), 0, 1)
        d = np.linalg.norm(p - (a0 + ab[None] * t[..., None] if p.ndim > 1 else a0 + ab * t), axis=-1)
        better = d < best
        best = np.where(better, d, best)
        tpos = np.where(better, (acc + t * seg_len[i]) / total, tpos)
        acc += seg_len[i]
    taper = np.clip(np.minimum(tpos, 1 - tpos) / 0.15, 0, 1)
    taper = taper * taper * (3 - 2 * taper)
    return a * np.clip(1 - (best / r) ** 2, 0, 1) ** 2 * taper


def _bounds(s):
    """Boîte englobante d'un coup (pour ne l'évaluer que là où il agit)."""
    if s["kind"] == "blob":
        c, r = np.asarray(s["c"]), np.asarray(s["r"])
        lo, hi = c - r, c + r
    else:
        pts = np.asarray(s["pts"])
        lo, hi = pts.min(0) - s["r"], pts.max(0) + s["r"]
    if s.get("sym"):
        lo[0], hi[0] = -max(abs(lo[0]), abs(hi[0])), max(abs(lo[0]), abs(hi[0]))
    return lo, hi


_BOUNDS = [_bounds(s) for s in STROKES]
_ALL_LO = np.min([b[0] for b in _BOUNDS], 0)
_ALL_HI = np.max([b[1] for b in _BOUNDS], 0)


def offset(p):
    """Décalage de surface (m) dû à la sculpture, pour des points (..., 3)."""
    shape = p.shape[:-1]
    flat = p.reshape(-1, 3)
    out = np.zeros(len(flat))
    near = np.all((flat >= _ALL_LO) & (flat <= _ALL_HI), axis=1)
    if not near.any():
        return out.reshape(shape)
    idx = np.nonzero(near)[0]
    q = flat[idx]
    acc = np.zeros(len(q))
    for s, (lo, hi) in zip(STROKES, _BOUNDS):
        m = np.all((q >= lo) & (q <= hi), axis=1)
        if not m.any():
            continue
        qq = q[m]
        if s.get("sym"):
            qq = qq.copy()
            qq[:, 0] = np.abs(qq[:, 0])
        if s["kind"] == "blob":
            acc[m] += _blob(qq, s["c"], s["r"], s["a"])
        else:
            acc[m] += _line(qq, s["pts"], s["r"], s["a"])
    out[idx] = acc
    return out.reshape(shape)
