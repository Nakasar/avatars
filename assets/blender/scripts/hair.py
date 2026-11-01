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
    rng = np.random.default_rng(seed)
    col = np.zeros((size, size, 3))
    alpha = np.zeros((size, size))
    ys = np.arange(size)

    def draw(x0, x1, y0, y1, n, width, tip_fade, color_jit, dark, curl, dens_alpha):
        h = y1 - y0
        for _ in range(n):
            xs = rng.uniform(x0, x1)
            ln = rng.uniform(0.55, 1.0) * h
            amp = rng.normal(0, curl)
            ph = rng.uniform(0, 2 * np.pi)
            yy = np.arange(y0, int(y0 + ln))
            t = (yy - y0) / max(ln, 1)
            xc = xs + amp * np.sin(t * np.pi * 0.8 + ph) * h * 0.02 + rng.normal(0, 0.4) * t * t * h * 0.03
            w = width * (1 - 0.7 * t)
            a = dens_alpha * np.clip(1 - t ** 2 * tip_fade, 0, 1)
            shade = 1 + rng.normal(0, color_jit)
            c = dark[None] * shade * (0.8 + 0.4 * t)[:, None]
            for dx in range(-2, 3):
                xi = np.round(xc).astype(int) + dx
                cov = np.clip(w + 0.5 - np.abs(xi - xc), 0, 1) * a
                ok = (xi >= x0) & (xi < x1)
                yi, xi2, cv = yy[ok], xi[ok], cov[ok]
                prev = alpha[yi, xi2]
                na = prev + cv * (1 - prev)
                wgt = np.where(na > 0, cv / np.maximum(na, 1e-6), 0)
                col[yi, xi2] = col[yi, xi2] * (1 - wgt[:, None]) + c[ok] * wgt[:, None]
                alpha[yi, xi2] = na

    # cheveux : 3 colonnes
    for k in range(3):
        x0, x1 = k * size // 4, (k + 1) * size // 4
        draw(x0 + 6, x1 - 6, 0, size, 420, 1.1, 1.0, 0.25, HAIR_COLOR, 0.6, 0.9)
    # cils : bande en bas à droite (racines en bas)
    x0, x1 = 3 * size // 4, size
    draw(x0 + 4, x1 - 4, 0, size // 2, 105, 0.75, 1.5, 0.1, np.array([0.014, 0.010, 0.009]), 1.2, 0.9)
    # sourcils : en haut à droite
    draw(x0 + 4, x1 - 4, size // 2, size, 340, 1.3, 0.8, 0.2, HAIR_COLOR * 0.55, 0.8, 1.0)
    # fond : couleur moyenne (évite des franges claires au filtrage)
    mean = HAIR_COLOR
    col = np.where(alpha[..., None] > 0.01, col, mean)
    return np.concatenate([col, alpha[..., None]], -1)


# --- Cuir chevelu -------------------------------------------------------------------------
HL_PHI = [0.0, 0.40, 0.70, 0.95, 1.10, 1.21, 1.31, 1.60, 1.90, 2.25, 2.70, np.pi]
HL_Z = [0.091, 0.087, 0.075, 0.044, 0.014, 0.000, 0.040, 0.050, 0.036, 0.000, -0.030, -0.042]


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


def hair_cards(seed=3):
    rng = np.random.default_rng(seed)
    verts, faces, uvs = [], [], []
    layers = [
        # (nb de directions, longueur dessus, longueur côtés, lift racine, lift pointe, largeur)
        (1300, 0.040, 0.016, 0.0012, 0.0045, 0.022),
        (800, 0.050, 0.020, 0.0035, 0.0085, 0.026),
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
        length = (l_side + (l_top - l_side) * top) * rng.uniform(0.8, 1.15, len(p))
        d0 = flow(p, n)
        n_seg = 4
        path, nr = walk_surface(p, d0, length, lift0, lift1, n_seg)
        for k in range(len(p)):
            o = len(verts)
            col = rng.integers(0, 3)
            u0, u1 = col / 4 + 0.01, (col + 1) / 4 - 0.01
            for i in range(n_seg + 1):
                q = path[i, k]
                t = path[min(i + 1, n_seg), k] - path[max(i - 1, 0), k]
                b = np.cross(nr[i, k], t)
                b /= max(np.linalg.norm(b), 1e-9)
                w = width * (1 - 0.35 * i / n_seg) * 0.5
                verts += [q - b * w, q + b * w]
                uvs_v = [(u0, i / n_seg), (u1, i / n_seg)]
                if i < n_seg:
                    a = o + 2 * i
                    faces.append([a, a + 1, a + 3, a + 2])
                    uvs.append([(u0, i / n_seg), (u1, i / n_seg), (u1, (i + 1) / n_seg), (u0, (i + 1) / n_seg)])
    return np.array(verts), faces, uvs


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


def brow_cards(seed=5):
    rng = np.random.default_rng(seed)
    verts, faces, uvs = [], [], []
    for s in (1, -1):
        n = 70
        for k in range(n):
            t = (k + rng.uniform(0, 1)) / n
            x, zc, th = brow_curve(t)
            z = zc + rng.uniform(-0.45, 0.35) * th
            root = np.array([[s * x, 0.0, z]])
            root[0, 1] = bh.frontal_surface(np.array([[s * x, z]]))[0]
            nr = normals(root)[0]
            # orientation des poils : vers le haut au début, puis vers l'extérieur
            ang = np.radians(80 - 75 * t ** 0.6 + rng.normal(0, 8))
            d = np.array([s * np.cos(ang), 0.0, np.sin(ang)])
            d -= nr * np.dot(d, nr)
            d /= np.linalg.norm(d)
            L = 0.0062 + rng.uniform(-0.001, 0.0012)
            w = 0.0016 * (1 - 0.3 * t) + 0.0008
            b = np.cross(nr, d)
            b /= np.linalg.norm(b)
            o = len(verts)
            rows = 3
            for i in range(rows):
                q = root[0] + d * L * i / (rows - 1) + nr * (0.0005 + 0.0004 * i)
                verts += [q - b * w / 2, q + b * w / 2]
                if i < rows - 1:
                    a = o + 2 * i
                    faces.append([a, a + 1, a + 3, a + 2] if s > 0 else [a + 1, a, a + 2, a + 3])
                    v0, v1 = 0.5 + 0.5 * i / (rows - 1), 0.5 + 0.5 * (i + 1) / (rows - 1)
                    uu = 0.76 + rng.uniform(0, 0.19)
                    q2 = [(uu, v0), (uu + 0.035, v0), (uu + 0.035, v1), (uu, v1)]
                    uvs.append(q2 if s > 0 else [q2[1], q2[0], q2[3], q2[2]])
    return np.array(verts), faces, uvs


# --- Cils ----------------------------------------------------------------------------------
def lash_strip(margin, s, upper):
    """Ruban de cils le long d'un bord libre (points ordonnés coin médial → latéral)."""
    c = hs.EYE_C * np.array([s, 1, 1])
    n = len(margin)
    t = np.linspace(0, 1, n)
    L = (0.0070 if upper else 0.0038) * (0.35 + 0.65 * np.sin(np.pi * np.clip(t * 1.05, 0, 1)) ** 0.6)
    verts, faces, uvs = [], [], []
    rows = 3
    for i, m in enumerate(margin):
        radial = (m - c) / np.linalg.norm(m - c)
        up = np.array([0, 0, 1.0 if upper else -1.0])
        d = radial * 0.75 + up * 0.55 + np.array([0, 0.25, 0])
        d /= np.linalg.norm(d)
        for r in range(rows):
            k = r / (rows - 1)
            # courbure : les cils se recourbent vers le haut (ou le bas) en bout
            q = m + radial * 0.0003 + d * L[i] * k + up * L[i] * 0.35 * k * k
            verts.append(q)
    for i in range(n - 1):
        for r in range(rows - 1):
            a = i * rows + r
            f = [a, a + rows, a + rows + 1, a + 1]
            faces.append(f if (s > 0) == upper else f[::-1])
            u0 = 0.755 + 0.235 * t[i]
            u1 = 0.755 + 0.235 * t[i + 1]
            v0, v1 = 0.5 * r / (rows - 1), 0.5 * (r + 1) / (rows - 1)
            q2 = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
            uvs.append(q2 if (s > 0) == upper else q2[::-1])
    return np.array(verts), faces, uvs
