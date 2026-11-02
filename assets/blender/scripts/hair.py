"""Poils : atlas de mèches (texture RGBA générée), cartes de cheveux courts, sourcils, cils.

Atlas 1024² :
  u ∈ [0, 0.75]  : 3 variantes de mèches de cheveux (racine en bas, pointe en haut) ;
  u ∈ [0.75, 1]  : v ∈ [0, 0.5] bande de cils ; v ∈ [0.5, 1] poils de sourcils.
"""
import numpy as np

import head_shape as hs
import build_head as bh
import sdf

HAIR_COLOR = np.array([0.060, 0.038, 0.024])      # brun foncé (linéaire)
WHORL = np.array([0.004, -0.060, 0.118])          # épi au sommet du crâne


# --- Texture ------------------------------------------------------------------------------
def strand_atlas(size=1024, seed=7):
    """Atlas RGBA : 6 touffes de mèches (u < 0.75, tons variés), cils et sourcils poil par
    poil (u > 0.75 ; 4 colonnes chacun)."""
    rng = np.random.default_rng(seed)
    col = np.zeros((size, size, 3))
    alpha = np.zeros((size, size))

    def strand(xs, y0, ln, width, color, alpha_max, curl, tip_fade=1.0, x_lo=0, x_hi=size, root_fade=0.0):
        amp = rng.normal(0, curl)
        ph = rng.uniform(0, 2 * np.pi)
        yy = np.arange(int(y0), int(min(y0 + ln, size)))
        if len(yy) < 2:
            return
        t = (yy - y0) / max(ln, 1)
        xc = xs + amp * np.sin(t * np.pi * 0.9 + ph) * ln * 0.03 + rng.normal(0, 0.5) * t * t * ln * 0.02
        w = width * (1 - 0.75 * t ** 1.5)
        a = alpha_max * np.clip(1 - t ** 2.2 * tip_fade, 0, 1)
        if root_fade > 0:  # racine estompée : pas de ligne nette à la base des cartes
            a = a * np.clip(t / root_fade, 0, 1) ** 0.7
        c = color[None] * (0.85 + 0.35 * t)[:, None]
        for dx in range(-3, 4):
            xi = np.round(xc).astype(int) + dx
            cov = np.clip(w + 0.5 - np.abs(xi - xc), 0, 1) * a
            ok = (xi >= x_lo) & (xi < x_hi) & (cov > 0)
            yi, xi2, cv = yy[ok], xi[ok], cov[ok]
            prev = alpha[yi, xi2]
            na = prev + cv * (1 - prev)
            wgt = np.where(na > 0, cv / np.maximum(na, 1e-6), 0)
            col[yi, xi2] = col[yi, xi2] * (1 - wgt[:, None]) + c[ok] * wgt[:, None]
            alpha[yi, xi2] = na

    tones = [1.0, 1.08, 0.9, 1.04, 0.95, 1.12]
    cw = size * 3 // 4 // 6
    for k, tone in enumerate(tones):
        x0, x1 = k * cw, (k + 1) * cw
        base = HAIR_COLOR * tone * np.array([1.0, 0.97 + 0.03 * k % 2, 0.95])
        # touffes : les mèches se regroupent vers 2-3 axes, plus clairsemées sur les bords
        axes = rng.uniform(x0 + cw * 0.25, x1 - cw * 0.25, 3)
        for _ in range(300):
            ax = axes[rng.integers(0, 3)]
            xs = np.clip(ax + rng.normal(0, cw * 0.24), x0 + 4, x1 - 4)
            shade = np.clip(1 + rng.normal(0, 0.15), 0.6, 1.5)
            grey = 0.6 if rng.uniform() < 0.015 else 1.0  # quelques poils plus clairs
            c = base * shade * (1 if grey == 1.0 else 2.2)
            strand(xs, rng.uniform(0, size * 0.08), size * rng.uniform(0.6, 1.0), rng.uniform(0.7, 1.3),
                   c, 0.95, 0.5, 1.0, x0, x1, root_fade=0.22)
    # cils : un poil courbe et effilé par colonne
    lw = (size - size * 3 // 4) // 4
    for k in range(4):
        x0 = size * 3 // 4 + k * lw
        for j in range(1):
            strand(x0 + lw * 0.5 + rng.normal(0, 2), 0, size * 0.5 * rng.uniform(0.85, 1.0), lw * 0.22,
                   np.array([0.012, 0.009, 0.008]), 1.0, 0.3, 1.2, x0, x0 + lw)
    # sourcils : un poil fin par colonne
    for k in range(4):
        x0 = size * 3 // 4 + k * lw
        strand(x0 + lw * 0.5, size * 0.5, size * 0.5 * rng.uniform(0.85, 1.0), lw * 0.22,
               HAIR_COLOR * 0.6 * (1 + 0.1 * k), 1.0, 0.2, 1.0, x0, x0 + lw)
    col = np.where(alpha[..., None] > 0.01, col, HAIR_COLOR)
    return np.concatenate([col, alpha[..., None]], -1)


# --- Cuir chevelu -------------------------------------------------------------------------
HL_PHI = [0.0, 0.40, 0.70, 0.95, 1.10, 1.21, 1.31, 1.60, 1.90, 2.25, 2.70, np.pi]
HL_Z = [0.095, 0.090, 0.077, 0.044, 0.014, 0.000, 0.040, 0.050, 0.036, 0.000, -0.030, -0.042]


def hairline_z(p):
    phi = np.abs(np.arctan2(p[..., 0], p[..., 1] + 0.010))
    return sdf.pchip(HL_PHI, HL_Z, phi)


def hair_mask(p, margin=0.0):
    """> 0 dans la zone chevelue (distance verticale signée à la ligne d'implantation)."""
    return p[..., 2] - hairline_z(p) - margin


def fib_dirs(n):
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)


def normals(p):
    g = bh.gradient(p)
    return g / np.linalg.norm(g, axis=1, keepdims=True)


def flow(p, n):
    """Direction de pousse : rayonne depuis l'épi, avec une composante de gravité sur les
    côtés et l'arrière ; projetée dans le plan tangent."""
    d = p - WHORL
    d[:, 2] *= 0.5
    side = np.clip((np.abs(np.arctan2(p[:, 0], p[:, 1] + 0.01)) - 0.8) / 1.2, 0, 1)
    d = d / np.linalg.norm(d, axis=1, keepdims=True)
    d += np.array([0, 0, -1.0]) * side[:, None] * 0.8
    # devant : légèrement vers le côté gauche (raie discrète)
    front = np.clip((p[:, 1] - 0.02) / 0.06, 0, 1) * np.clip((p[:, 2] - 0.06) / 0.04, 0, 1)
    d += np.array([0.35, 0.3, 0]) * front[:, None]
    d -= np.sum(d * n, 1)[:, None] * n
    return d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)


def walk_surface(p, step_dir, length, lift0, lift1, n_seg):
    """Fait avancer des points sur la surface décalée ; retourne (n_seg+1, N, 3) et normales."""
    pts, nrms = [], []
    cur = p.copy()
    d = step_dir.copy()
    for i in range(n_seg + 1):
        n = normals(cur)
        lift = lift0 + (lift1 - lift0) * (i / n_seg) ** 0.8
        pts.append(cur + n * lift[:, None] if np.ndim(lift) else cur + n * lift)
        nrms.append(n)
        if i == n_seg:
            break
        d = flow(cur, n) * 0.5 + d * 0.5
        d -= np.sum(d * n, 1)[:, None] * n
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        cur = bh.snap(cur + d * (length / n_seg)[:, None], 3)
    return np.array(pts), np.array(nrms)


def hair_guides(seed=3):
    """Guides de mèches (courbes) posées sur le cuir chevelu : liste de tableaux (n, 3)
    et largeurs de carte associées."""
    rng = np.random.default_rng(seed)
    guides, widths, layers_of = [], [], []
    layers = [
        # (nb de directions, longueur dessus, longueur côtés, lift racine, lift pointe, largeur)
        (2000, 0.040, 0.015, 0.0010, 0.0030, 0.016),
        (700, 0.048, 0.019, 0.0026, 0.0055, 0.018),
    ]
    for li, (ndir, l_top, l_side, lift0, lift1, width) in enumerate(layers):
        dirs = fib_dirs(ndir)
        dirs = dirs[dirs[:, 2] > -0.6]
        p = bh.project(dirs)
        m = hair_mask(p, 0.004 if li == 0 else 0.010)
        p = p[m > 0]
        p += rng.normal(0, 0.002, p.shape)
        p = bh.snap(p, 3)
        n = normals(p)
        top = np.clip((p[:, 2] - 0.07) / 0.04, 0, 1)
        length = (l_side + (l_top - l_side) * top) * rng.uniform(0.75, 1.2, len(p))
        d0 = flow(p, n)
        # légère dispersion de direction : mèches moins parallèles
        jitter = rng.normal(0, 0.08, d0.shape)
        jitter -= np.sum(jitter * n, 1)[:, None] * n
        d0 = d0 + jitter
        d0 /= np.linalg.norm(d0, axis=1, keepdims=True)
        path, _ = walk_surface(p, d0, length, lift0, lift1 * rng.uniform(0.7, 1.3), 4)
        for k in range(len(p)):
            guides.append(path[:, k])
            widths.append(width * rng.uniform(0.75, 1.25))
            layers_of.append(li)
    return guides, widths


def cards_from_guides(guides, widths, seed=4):
    """Cartes alpha le long des guides (largeur effilée, orientées sur le crâne)."""
    rng = np.random.default_rng(seed)
    verts, faces, uvs = [], [], []
    for g, w0 in zip(guides, widths):
        n_seg = len(g) - 1
        o = len(verts)
        col = rng.integers(0, 6)
        u0, u1 = col / 8 + 0.004, (col + 1) / 8 - 0.004
        nr = normals(np.asarray(g))
        twist = rng.normal(0, 0.10)
        for i in range(n_seg + 1):
            q = g[i]
            t = g[min(i + 1, n_seg)] - g[max(i - 1, 0)]
            b = np.cross(nr[i], t)
            b /= max(np.linalg.norm(b), 1e-9)
            # légère torsion de la carte autour de la mèche
            b = b * np.cos(twist * i / n_seg) + nr[i] * np.sin(twist * i / n_seg)
            w = w0 * (1 - 0.45 * i / n_seg) * 0.5
            verts += [q - b * w, q + b * w]
            if i < n_seg:
                a = o + 2 * i
                faces.append([a, a + 1, a + 3, a + 2])
                uvs.append([(u0, i / n_seg), (u1, i / n_seg), (u1, (i + 1) / n_seg), (u0, (i + 1) / n_seg)])
    return np.array(verts), faces, uvs


def hair_cards(seed=3):
    g, w = hair_guides(seed)
    return cards_from_guides(g, w)


# --- Sourcils ------------------------------------------------------------------------------
def brow_curve(t):
    x = 0.0125 + (0.0515 - 0.0125) * t
    z = 0.0372 + 0.0068 * np.sin(np.pi * t ** 0.75) - 0.0030 * t
    thick = 0.0092 * (1 - t) + 0.0032 * t
    return x, z, thick


def brow_mask(p):
    """Densité de sourcil (0–1) pour un point de surface (sert aussi à peindre la peau)."""
    x = np.abs(p[..., 0])
    t = np.clip((x - 0.0125) / (0.0515 - 0.0125), -0.3, 1.3)
    _, zc, th = brow_curve(np.clip(t, 0, 1))
    dz = (p[..., 2] - zc) / (th * 0.5)
    ends = sdf.smoothstep(-0.12, 0.05, t) * (1 - sdf.smoothstep(0.93, 1.08, t))
    front = sdf.smoothstep(0.05, 0.07, p[..., 1])
    return np.exp(-dz ** 2 * 1.6) * ends * front


def strip(root, d, nrm, length, width, col, v0, v1, rows=3, curl=0.0):
    """Poil isolé : ruban fin de `rows` rangées, colonne `col` de l'atlas (u > 0.75)."""
    b = np.cross(nrm, d)
    b /= max(np.linalg.norm(b), 1e-9)
    verts, uvs = [], []
    lw = 0.25 / 4
    u0 = 0.75 + col * lw + lw * 0.15
    u1 = 0.75 + (col + 1) * lw - lw * 0.15
    for i in range(rows):
        k = i / (rows - 1)
        q = root + d * length * k + nrm * (curl * length * k * k)
        w = width * (1 - 0.5 * k)
        verts += [q - b * w / 2, q + b * w / 2]
    faces = [[2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2] for i in range(rows - 1)]
    for i in range(rows - 1):
        a, c = v0 + (v1 - v0) * i / (rows - 1), v0 + (v1 - v0) * (i + 1) / (rows - 1)
        uvs.append([(u0, a), (u1, a), (u1, c), (u0, c)])
    return verts, faces, uvs


def brow_cards(seed=5):
    """Sourcils poil par poil : ~170 poils par côté, orientés vers le haut puis vers la tempe."""
    rng = np.random.default_rng(seed)
    verts, faces, uvs = [], [], []
    for s in (1, -1):
        n = 300
        for k in range(n):
            t = np.clip(rng.beta(1.3, 1.1), 0, 1)
            x, zc, th = brow_curve(t)
            z = zc + rng.normal(0, 0.28) * th
            root = np.array([s * x, 0.0, z])
            root[1] = bh.frontal_surface(np.array([[s * x, z]]))[0]
            nr = normals(root[None])[0]
            ang = np.radians(78 - 72 * t ** 0.6 + rng.normal(0, 10))
            d = np.array([s * np.cos(ang), 0.0, np.sin(ang)])
            d -= nr * np.dot(d, nr)
            d /= np.linalg.norm(d)
            L = 0.0055 + rng.uniform(-0.0012, 0.0015)
            v, f, uv = strip(root + nr * 0.0003, d, nr, L, 0.0011, rng.integers(0, 4), 0.5, 1.0, 3, 0.15)
            o = len(verts)
            verts += v
            faces += [[o + i for i in ff] for ff in f]
            uvs += uv
    return np.array(verts), faces, uvs


# --- Cils ----------------------------------------------------------------------------------
def lash_strip(margin, s, upper, seed=9):
    """Cils un par un le long d'un bord libre (points ordonnés coin médial → latéral)."""
    rng = np.random.default_rng(seed + (0 if upper else 1) + (0 if s > 0 else 2))
    c = hs.EYE_C * np.array([s, 1, 1])
    m = np.asarray(margin)
    tt = np.linspace(0, 1, len(m))
    count = 62 if upper else 30
    verts, faces, uvs = [], [], []
    for k in range(count):
        t = np.clip((k + rng.uniform(0.1, 0.9)) / count, 0.04, 0.97)
        root = np.array([np.interp(t, tt, m[:, i]) for i in range(3)])
        radial = (root - c) / np.linalg.norm(root - c)
        up = np.array([0, 0, 1.0 if upper else -1.0])
        d = radial * 0.75 + up * 0.55 + np.array([0, 0.25, 0]) + rng.normal(0, 0.08, 3)
        # vers le coin latéral, les cils s'inclinent vers la tempe
        d += np.array([s * 0.35 * max(t - 0.6, 0), 0, 0])
        d /= np.linalg.norm(d)
        L = (0.0085 if upper else 0.0045) * (0.45 + 0.55 * np.sin(np.pi * np.clip(t * 1.05, 0, 1)) ** 0.6)
        L *= rng.uniform(0.8, 1.15)
        side = np.cross(d, radial)
        nrm = np.cross(side, d)
        nrm /= max(np.linalg.norm(nrm), 1e-9)
        if np.dot(nrm, up) < 0:
            nrm = -nrm
        v, f, uv = strip(root + radial * 0.0003, d, nrm, L, 0.0008, rng.integers(0, 4), 0.0, 0.5, 3, 0.35)
        o = len(verts)
        verts += v
        faces += [[o + i for i in ff] for ff in f]
        uvs += uv
    return np.array(verts), faces, uvs
