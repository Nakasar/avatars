"""Forme anatomique de la tête : champ implicite construit à partir de mesures
anthropométriques d'un homme adulte (repère et unités : voir sdf.py).

La base est un « loft » de sections horizontales (front en superellipse, arrière en ellipse),
complété par le crâne, le cou et des volumes anatomiques (arcades, pommettes, nez, lèvres,
orbites, paupières) fusionnés par unions lisses.
"""
import numpy as np
from sdf import smin, smax, ellipsoid, sphere, cone_capsule, pchip, smoothstep, length

# --- Repères anatomiques (mètres) -------------------------------------------------------
EYE_C = np.array([0.0322, 0.0705, 0.0195])   # centre du globe gauche (x > 0)
EYE_R = 0.0121
LID_T = 0.0016                               # épaisseur des paupières au-dessus du globe
MOUTH_Z = -0.0468                            # stomion
MOUTH_W = 0.0255                             # demi-largeur de la bouche (cheilion)

# Sections du loft : z, profondeur médiane avant P, demi-largeur W, position fs de la
# largeur max, profondeur arrière Bk, exposants (largeur ex, profondeur ey).
LOFT = np.array([
    # z       P       W       fs      Bk      ex    ey
    [0.078, 0.0860, 0.0660, -0.010, -0.100, 2.7, 2.1],
    [0.060, 0.0950, 0.0700, -0.008, -0.100, 2.8, 2.3],
    [0.044, 0.1005, 0.0728, -0.006, -0.098, 2.9, 2.5],
    [0.022, 0.0880, 0.0712, -0.004, -0.092, 2.3, 2.1],
    [0.004, 0.0915, 0.0705, 0.000, -0.080, 2.5, 2.8],
    [-0.016, 0.0950, 0.0672, 0.000, -0.062, 2.3, 2.6],
    [-0.034, 0.0965, 0.0618, -0.002, -0.045, 2.1, 2.35],
    [-0.050, 0.0955, 0.0585, 0.000, -0.032, 2.05, 2.2],
    # tiers inférieur ramené à ~7 cm (subnasale → menton), menton plus carré
    [-0.0615, 0.0925, 0.0530, 0.012, -0.004, 2.05, 2.05],
    [-0.0730, 0.0985, 0.0420, 0.034, 0.020, 2.3, 2.0],
    [-0.0830, 0.0965, 0.0310, 0.054, 0.045, 2.6, 2.0],
    [-0.0905, 0.0870, 0.0190, 0.066, 0.060, 2.6, 2.0],
    [-0.0950, 0.0760, 0.0050, 0.070, 0.066, 2.2, 2.0],
])


def loft(p):
    x, f, z = p[..., 0], p[..., 1], p[..., 2]
    tab = LOFT[::-1]  # z croissant pour l'interpolation
    cols = [pchip(tab[:, 0], tab[:, i], z) for i in range(1, 7)]
    P, W, fs, Bk, ex, ey = cols
    u = np.abs(x) / W
    front = f >= fs
    vf = np.maximum(f - fs, 0) / np.maximum(P - fs, 1e-4)
    vb = np.maximum(fs - f, 0) / np.maximum(fs - Bk, 1e-4)
    nf = (u ** ex + vf ** ey) ** (1.0 / np.maximum(ex, ey))
    nb = np.sqrt(u * u + vb * vb)
    n = np.where(front, nf, nb)
    scale = np.minimum(W, np.where(front, P - fs, fs - Bk))
    d = (n - 1.0) * scale
    # bornes verticales : le loft s'arrête sous le menton et au-dessus du front
    d = smax(d, LOFT[-1, 0] - z, 0.004)
    d = smax(d, z - LOFT[0, 0] - 0.01, 0.01)
    return d


def cranium(p):
    return ellipsoid(p, (0.0, -0.006, 0.046), (0.0790, 0.0995, 0.0900))


def neck(p):
    # cou : plus étroit sous la mâchoire, s'évase vers la base ; trapèzes vers les épaules
    d = cone_capsule(p, (0.0, -0.020, -0.25), (0.0, -0.016, -0.050), 0.063, 0.0505)
    for s in (-1, 1):
        trap = cone_capsule(p, (s * 0.012, -0.044, -0.122), (s * 0.150, -0.030, -0.194), 0.033, 0.040)
        d = smin(d, trap, 0.030)
    return d


def nose(p, d):
    # corps du nez : volume large qui se fond dans les joues
    body = ellipsoid(p, (0, 0.0915, -0.004), (0.0125, 0.0105, 0.021))
    d = smin(d, body, 0.008)
    dorsum = cone_capsule(p, (0, 0.0915, 0.0235), (0, 0.1100, -0.0095), 0.0042, 0.0062)
    tip = ellipsoid(p, (0, 0.1080, -0.0135), (0.0078, 0.0078, 0.0078))
    colum = cone_capsule(p, (0, 0.1065, -0.0192), (0, 0.0985, -0.0238), 0.0034, 0.0031)
    n = smin(dorsum, tip, 0.006)
    # lobule de la pointe légèrement bilobé (cartilages alaires)
    for s in (-1, 1):
        n = smin(n, ellipsoid(p, (s * 0.0033, 0.1098, -0.0132), (0.0050, 0.0058, 0.0058)), 0.003)
    n = smin(n, colum, 0.003)
    for s in (-1, 1):
        ala = ellipsoid(p, (s * 0.0128, 0.0970, -0.0175), (0.0070, 0.0088, 0.0062))
        n = smin(n, ala, 0.0065)
    d = smin(d, n, 0.0065)
    for s in (-1, 1):
        nostril = ellipsoid(p, (s * 0.0066, 0.1025, -0.0246), (0.0030, 0.0045, 0.0014))
        d = smax(d, -nostril, 0.0022)
    return d


def lips(p, d):
    x, f, z = p[..., 0], p[..., 1], p[..., 2]
    # les lèvres suivent l'arcade dentaire : recul parabolique vers les commissures
    arch = 26.0 * x * x
    q = p.copy()
    q[..., 1] = f + arch
    up = ellipsoid(q, (0, 0.0952, MOUTH_Z + 0.0054), (0.0245, 0.0072, 0.0054))
    lo = ellipsoid(q, (0, 0.0935, MOUTH_Z - 0.0072), (0.0228, 0.0078, 0.0072))
    d = smin(d, up, 0.005)
    d = smin(d, lo, 0.0085)
    # philtrum : deux crêtes légères et une gouttière
    phil = ellipsoid(q, (0, 0.1012, MOUTH_Z + 0.0135), (0.0040, 0.0025, 0.0060))
    d = smax(d, -phil, 0.002)
    # colonnes du philtre et tubercule de la lèvre supérieure
    tub = ellipsoid(q, (0, 0.0995, MOUTH_Z + 0.0030), (0.0055, 0.0030, 0.0028))
    d = smin(d, tub, 0.0025)
    return d


def eyes(p, d):
    for s in (-1, 1):
        c = EYE_C * np.array([s, 1, 1])
        # orbite : creux sous l'arcade, au-dessus et autour du globe
        orbit = ellipsoid(p, c * np.array([1, 0, 0]) + np.array([s * 0.0008, 0.0868, 0.0275]), (0.0150, 0.0048, 0.0085))
        d = smax(d, -orbit, 0.006)
        # paupières : coque autour du globe
        lid = sphere(p, c, EYE_R + LID_T)
        d = smin(d, lid, 0.0040)
    return d


def features(p, d):
    for s in (-1, 1):
        # arcades sourcilières et glabelle
        brow = cone_capsule(p, (s * 0.010, 0.0940, 0.0360), (s * 0.048, 0.0770, 0.0400), 0.0060, 0.0045)
        d = smin(d, brow, 0.008)
        # pommettes (zygomatiques)
        cheek = ellipsoid(p, (s * 0.050, 0.061, 0.008), (0.017, 0.013, 0.010))
        d = smin(d, cheek, 0.012)
        # tempes légèrement creusées
        # bord inférieur de la mandibule (de l'angle au menton)
        mand = cone_capsule(p, (s * 0.052, -0.004, -0.057), (s * 0.021, 0.080, -0.0855), 0.0066, 0.0056)
        d = smin(d, mand, 0.009)
        # joue sous la pommette (léger creux) et bourrelet naso-génien
        hollow = ellipsoid(p, (s * 0.060, 0.058, -0.030), (0.007, 0.014, 0.011))
        d = smax(d, -hollow, 0.012)
        malar = ellipsoid(p, (s * 0.034, 0.0810, -0.022), (0.010, 0.007, 0.011))
        d = smin(d, malar, 0.010)
    # menton : saillie de la symphyse
    chin = ellipsoid(p, (0, 0.089, -0.0785), (0.021, 0.011, 0.011))
    d = smin(d, chin, 0.008)
    return d


def field(p):
    """Champ implicite de la tête et du cou (négatif à l'intérieur)."""
    d = smin(cranium(p), loft(p), 0.02)
    d = features(p, d)
    d = eyes(p, d)
    d = nose(p, d)
    d = lips(p, d)
    d = smin(d, neck(p), 0.012)
    return d


def raycast(origins, dirs, fn=field, t_max=0.32, step=0.002, iters=14):
    """Première sortie (intérieur → extérieur) du champ le long de chaque rayon."""
    n = len(dirs)
    out = np.full(n, np.nan)
    ts = np.arange(0.004, t_max, step)
    for a in range(0, n, 1500):
        o = origins[a:a + 1500, None, :]
        dv = dirs[a:a + 1500, None, :]
        pts = o + dv * ts[None, :, None]
        v = fn(pts.reshape(-1, 3)).reshape(len(dv), len(ts))
        inside = v < 0
        cross = inside[:, :-1] & ~inside[:, 1:]
        has = cross.any(axis=1)
        idx = np.argmax(cross, axis=1)
        lo = ts[idx]
        hi = ts[idx + 1]
        oo = o[:, 0, :]
        dd = dv[:, 0, :]
        for _ in range(iters):
            mid = 0.5 * (lo + hi)
            vm = fn(oo + dd * mid[:, None])
            ins = vm < 0
            lo = np.where(ins, mid, lo)
            hi = np.where(ins, hi, mid)
        out[a:a + 1500] = np.where(has, 0.5 * (lo + hi), np.nan)
    return out
