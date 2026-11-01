"""Pièces anatomiques séparées : globes oculaires, cornées, dents, gencives, langue, oreilles.

Chaque fonction retourne (sommets anatomiques, faces, uvs par coin de face ou None).
"""
import numpy as np

import head_shape as hs

JAW_PIVOT = np.array([0.0, 0.010, -0.008])   # axe de rotation de la mandibule (ATM), selon x


def grid_faces(rows, cols, closed=True, offset=0):
    """Faces quads d'une grille rows×cols (colonnes refermées si closed)."""
    faces = []
    cc = cols if closed else cols - 1
    for i in range(rows - 1):
        for j in range(cc):
            a = offset + i * cols + j
            b = offset + i * cols + (j + 1) % cols
            faces.append([a, b, b + cols, a + cols])
    return faces


# --- Yeux ------------------------------------------------------------------------------
LIMBUS = 0.0058
IRIS_DEPTH = 0.0104


def eyeball(s):
    """Globe oculaire orienté vers +f ; iris aplati (plan) légèrement en retrait."""
    c = hs.EYE_C * np.array([s, 1, 1])
    R = hs.EYE_R
    al_l = np.arcsin(LIMBUS / R)
    alphas = np.concatenate([
        np.linspace(np.radians(2.0), al_l * 0.999, 9),
        np.radians([31, 36, 45, 58, 75, 95, 118, 142, 165, 178]),
    ])
    nseg = 32
    beta = np.linspace(0, 2 * np.pi, nseg, endpoint=False)
    verts, uvs_v = [], []
    for a in alphas:
        for b in beta:
            if a < al_l:
                r = R * np.sin(a)
                p = np.array([r * np.cos(b), IRIS_DEPTH - 0.0003 * (r / LIMBUS) ** 2 * 0 + 0.0, r * np.sin(b)])
                # iris légèrement bombé vers l'avant au centre (collerette)
                p[1] = IRIS_DEPTH + 0.0004 * (1 - (r / LIMBUS) ** 2)
            else:
                p = np.array([R * np.sin(a) * np.cos(b), R * np.cos(a), R * np.sin(a) * np.sin(b)])
            verts.append(c + p)
            rr = a / np.pi * 0.5
            uvs_v.append((0.5 + rr * np.cos(b), 0.5 + rr * np.sin(b)))
    faces = grid_faces(len(alphas), nseg)
    # pôle avant (pupille) et arrière
    front = len(verts)
    verts.append(c + np.array([0, IRIS_DEPTH + 0.0004, 0]))
    uvs_v.append((0.5, 0.5))
    back = len(verts)
    verts.append(c + np.array([0, -R, 0]))
    uvs_v.append((0.5, 0.0))
    for j in range(nseg):
        faces.append([front, (j + 1) % nseg, j])
        o = (len(alphas) - 1) * nseg
        faces.append([back, o + j, o + (j + 1) % nseg])
    # les faces de grille sont orientées vers l'intérieur : on les retourne
    faces = [f[::-1] if len(f) == 4 else f for f in faces[:-2 * nseg]] + faces[-2 * nseg:]
    uv = [[uvs_v[i] for i in f] for f in faces]
    return np.array(verts), faces, uv


def cornea(s):
    """Calotte cornéenne transparente (rayon de courbure 7,8 mm) qui bombe devant l'iris."""
    c = hs.EYE_C * np.array([s, 1, 1])
    rc = 0.0078
    cf = np.sqrt(hs.EYE_R ** 2 - LIMBUS ** 2) - np.sqrt(rc ** 2 - LIMBUS ** 2)
    th_max = np.arcsin((LIMBUS + 0.0004) / rc)
    ths = np.linspace(np.radians(4), th_max, 8)
    nseg = 32
    beta = np.linspace(0, 2 * np.pi, nseg, endpoint=False)
    verts = []
    for t in ths:
        for b in beta:
            verts.append(c + np.array([0, cf, 0]) + rc * np.array([np.sin(t) * np.cos(b), np.cos(t), np.sin(t) * np.sin(b)]))
    faces = [f[::-1] for f in grid_faces(len(ths), nseg)]
    apex = len(verts)
    verts.append(c + np.array([0, cf + rc, 0]))
    for j in range(nseg):
        faces.append([apex, j, (j + 1) % nseg])
    uv = [[(0.5, 0.5)] * len(f) for f in faces]
    return np.array(verts), faces, uv


# --- Dents ------------------------------------------------------------------------------
UPPER = dict(f0=0.0905, half=0.0265, depth=0.040, edge=hs.MOUTH_Z - 0.0006, sign=1)
LOWER = dict(f0=0.0880, half=0.0240, depth=0.038, edge=hs.MOUTH_Z + 0.0010, sign=-1)
# (largeur, épaisseur, hauteur de couronne) des dents, de l'incisive centrale à la 2e molaire
UPPER_TEETH = [(8.4, 7.0, 10.0), (6.6, 6.2, 8.8), (7.6, 8.0, 9.6), (7.0, 9.0, 8.0),
               (6.6, 9.0, 7.6), (10.0, 11.0, 7.0), (9.0, 10.5, 6.6)]
LOWER_TEETH = [(5.2, 6.0, 8.6), (5.8, 6.2, 8.8), (6.8, 7.5, 10.0), (7.0, 7.8, 8.2),
               (7.0, 8.0, 7.8), (11.0, 10.5, 7.2), (10.2, 10.0, 6.8)]


def arch_point(arch, x):
    a = arch["depth"] / arch["half"] ** 2
    f = arch["f0"] - a * x * x
    tang = np.array([1.0, -2 * a * x, 0.0])
    tang /= np.linalg.norm(tang)
    return np.array([x, f, 0.0]), tang


def arch_x_at_length(arch, s):
    """Abscisse x telle que la longueur d'arc depuis le centre vaut s (s ≥ 0)."""
    xs = np.linspace(0, arch["half"] * 1.8, 2000)
    a = arch["depth"] / arch["half"] ** 2
    ds = np.sqrt(1 + (2 * a * xs) ** 2)
    L = np.concatenate([[0], np.cumsum(0.5 * (ds[1:] + ds[:-1]) * np.diff(xs))])
    return np.interp(s, L, xs)


def superellipsoid(a, b, c, e1, e2, nu=8, nv=6):
    """Superellipsoïde (demi-axes a, b, c), topologie UV sans pôles dégénérés trop fins."""
    us = np.linspace(-np.pi / 2 * 0.92, np.pi / 2 * 0.92, nv)
    vs = np.linspace(-np.pi, np.pi, nu, endpoint=False)
    sp = lambda w, m: np.sign(np.sin(w)) * np.abs(np.sin(w)) ** m
    cp = lambda w, m: np.sign(np.cos(w)) * np.abs(np.cos(w)) ** m
    verts = []
    for u in us:
        for v in vs:
            verts.append([a * cp(u, e1) * cp(v, e2), b * cp(u, e1) * sp(v, e2), c * sp(u, e1)])
    faces = grid_faces(nv, nu)
    bot = len(verts)
    verts.append([0, 0, -c])
    top = len(verts)
    verts.append([0, 0, c])
    for j in range(nu):
        faces.append([bot, (j + 1) % nu, j])
        o = (nv - 1) * nu
        faces.append([top, o + j, o + (j + 1) % nu])
    return np.array(verts), faces


def teeth(arch, spec):
    verts, faces = [], []
    s = 0.0
    sizes = [(w * 0.92e-3, t * 1e-3, h * 1e-3) for w, t, h in spec]
    for side in (1, -1):
        s = 0.0
        for k, (w, t, h) in enumerate(sizes):
            sc = s + w / 2
            s += w
            x = side * arch_x_at_length(arch, sc)
            p, tang = arch_point(arch, x)
            tang = tang * side
            nrm = np.cross(np.array([0, 0, 1.0]), tang)  # vers l'extérieur de l'arcade
            if nrm[1] < 0:
                nrm = -nrm
            # forme : incisives plates et fines au bord, molaires cubiques
            e1 = 0.35 if k < 3 else 0.25
            e2 = 0.55 if k < 3 else 0.35
            v, f = superellipsoid(w / 2, t / 2, h * 0.75, e1, e2)
            # amincissement vers le bord incisif (incisives / canines)
            zt = (v[:, 2] / (h * 0.75)) * arch["sign"]   # +1 côté racine
            thin = np.where(zt < 0, 1 - (0.55 if k < 3 else 0.2) * (-zt) ** 1.5, 1.0)
            v[:, 1] *= thin
            if k == 2:  # canine : pointe
                v[:, 0] *= np.where(zt < 0, 1 - 0.35 * (-zt) ** 2, 1.0)
            # repère : x local = tangente, y local = normale extérieure, z vertical
            m = np.stack([tang, nrm, np.array([0, 0, 1.0])], 1)
            centre = p + np.array([0, 0, arch["edge"] + arch["sign"] * h * 0.70]) - nrm * (t / 2 - 0.0005)
            if k >= 3:  # dents postérieures légèrement plus courtes vers le fond
                centre[2] += arch["sign"] * 0.0006 * (k - 2)
            vv = centre + v @ m.T
            o = len(verts)
            verts.extend(vv.tolist())
            faces.extend([[o + i for i in ff] for ff in f])
    return np.array(verts), faces, None


def gums(arch):
    """Gencive : profil arrondi balayé le long de l'arcade, au-dessus (ou dessous) des dents."""
    sg = arch["sign"]
    xs = np.concatenate([-np.linspace(arch["half"] * 1.25, 0, 18)[:-1], np.linspace(0, arch["half"] * 1.25, 18)])
    prof = []
    for a in np.linspace(-np.pi * 0.95, np.pi * 0.95, 10):
        prof.append((0.0045 * np.sin(a), 0.0045 + 0.0040 * np.cos(a)))   # (normale, hauteur)
    verts = []
    for x in xs:
        p, tang = arch_point(arch, x)
        nrm = np.cross(np.array([0, 0, 1.0]), tang)
        if nrm[1] < 0:
            nrm = -nrm
        base = p + np.array([0, 0, arch["edge"] + sg * 0.0075]) - nrm * 0.003
        for n_off, h in prof:
            verts.append(base + nrm * n_off + np.array([0, 0, sg * h]))
    faces = grid_faces(len(xs), len(prof), closed=False)
    if sg > 0:
        faces = [f[::-1] for f in faces]
    return np.array(verts), faces, None


def tongue():
    nu, nv = 24, 12
    verts = []
    for i, u in enumerate(np.linspace(-np.pi / 2 * 0.95, np.pi / 2 * 0.95, nv)):
        for v in np.linspace(-np.pi, np.pi, nu, endpoint=False):
            x = 0.0215 * np.cos(u) * np.cos(v)
            f = 0.030 * np.cos(u) * np.sin(v)
            z = 0.0085 * np.sin(u)
            # dos plat, pointe plus fine
            if z > 0:
                z *= 0.75
            tip = max(0.0, f / 0.030)
            x *= 1 - 0.35 * tip ** 2
            verts.append([x, 0.0595 + f, hs.MOUTH_Z - 0.0085 + z])
    faces = [f[::-1] for f in grid_faces(nv, nu)]
    bot = len(verts)
    verts.append([0, 0.0595, hs.MOUTH_Z - 0.0085 - 0.0085])
    top = len(verts)
    verts.append([0, 0.0595, hs.MOUTH_Z - 0.0085 + 0.0064])
    for j in range(nu):
        faces.append([bot, j, (j + 1) % nu])
        o = (nv - 1) * nu
        faces.append([top, o + (j + 1) % nu, o + j])
    return np.array(verts), faces, None


# --- Oreilles ---------------------------------------------------------------------------
def ear(s):
    """Pavillon : feuillet avant en relief (hélix, anthélix, conque, tragus, lobule) et
    feuillet arrière, raccordés au bord. Construit dans le plan de l'oreille puis posé sur
    le côté de la tête."""
    n_sp, n_r = 28, 11
    th = np.linspace(0, 2 * np.pi, n_sp, endpoint=False)    # 0 = vers l'avant, π/2 = haut

    def outline(t):
        # contour (m) : plus large en haut, lobule arrondi en bas, bord avant presque droit
        up = 0.5 + 0.5 * np.sin(t)
        r = 0.0150 + 0.0175 * up ** 1.4
        back = 0.5 - 0.5 * np.cos(t)
        r *= 0.86 + 0.24 * back
        lob = np.exp(-((t - 1.5 * np.pi) / 0.5) ** 2)
        r += 0.010 * lob
        front = np.exp(-(np.angle(np.exp(1j * t)) / 0.5) ** 2)
        r -= 0.0045 * front
        return r

    def height(rn, t):
        # relief (m) en fonction du rayon normalisé et de l'angle
        up = 0.5 + 0.5 * np.sin(t)
        back = 0.5 - 0.5 * np.cos(t)
        lob = np.exp(-((t - 1.5 * np.pi) / 0.55) ** 2)
        frontal = np.exp(-(np.angle(np.exp(1j * t)) / 0.6) ** 2)
        helix = 0.0042 * np.exp(-((rn - 0.93) / 0.07) ** 2) * (1 - 0.8 * lob) * (1 - 0.6 * frontal * (1 - up))
        scapha = -0.0012 * np.exp(-((rn - 0.80) / 0.06) ** 2) * up
        antihelix = 0.0036 * np.exp(-((rn - 0.62) / 0.09) ** 2) * (0.35 + 0.65 * back) * (1 - lob)
        concha = -0.0040 * np.exp(-(rn / 0.40) ** 2) * (1 - 0.5 * up)
        tragus = 0.0040 * np.exp(-((rn - 0.42) / 0.12) ** 2) * frontal * (1 - up)
        antitragus = 0.0030 * np.exp(-((rn - 0.50) / 0.10) ** 2) * np.exp(-((t - 1.25 * np.pi) / 0.35) ** 2)
        lobule = 0.0022 * lob * np.exp(-((rn - 0.7) / 0.3) ** 2)
        return helix + scapha + antihelix + concha + tragus + antitragus + lobule

    rs = np.concatenate([[0.10, 0.18], np.linspace(0.28, 1.0, n_r - 2)])
    front, back = [], []
    for rn in rs:
        for t in th:
            R = outline(t)
            u = 0.002 + R * rn * np.cos(t)           # vers l'avant
            v = -0.003 + R * rn * np.sin(t)          # vers le haut
            h = height(rn, t)
            front.append([u, v, h])
            # feuillet arrière : épaisseur au bord, rentre dans la tête au centre
            th_b = 0.0022 + 0.0016 * rn
            back.append([u, v, h - th_b - 0.006 * (1 - rn) ** 2])
    front = np.array(front)
    back = np.array(back)
    nf = len(front)
    verts = np.concatenate([front, back])
    faces = grid_faces(len(rs), n_sp)                  # feuillet avant
    faces += [[i + nf for i in f[::-1]] for f in grid_faces(len(rs), n_sp)]
    o = (len(rs) - 1) * n_sp
    for j in range(n_sp):                                # bord (hélix) : raccord des feuillets
        a, b = o + j, o + (j + 1) % n_sp
        faces.append([b, a, a + nf, b + nf])
    # conduit auditif : la boucle centrale descend dans la tête
    canal = []
    for j, t in enumerate(th):
        canal.append([0.002 + 0.0035 * np.cos(t), -0.003 + 0.0035 * np.sin(t), -0.008])
    ci = len(verts)
    verts = np.concatenate([verts, np.array(canal)])
    for j in range(n_sp):
        a, b = j, (j + 1) % n_sp
        faces.append([a, b, ci + b, ci + a][::-1])
    # pose sur la tête : plan de l'oreille incliné vers l'arrière, décollé de ~20°
    tilt = np.radians(-16)     # inclinaison du grand axe vers l'arrière
    flare = np.radians(30)     # angle céphalo-auriculaire
    u, v, h = verts[:, 0] * 1.08, verts[:, 1] * 1.08, verts[:, 2]
    u2 = u * np.cos(tilt) - v * np.sin(tilt)
    v2 = u * np.sin(tilt) + v * np.cos(tilt)
    fpos, zpos = -0.004 + u2, 0.006 + v2
    # base posée sur la surface du crâne (rayon horizontal depuis l'intérieur)
    xs = np.linspace(0.04, 0.11, 351)
    q = np.stack([np.broadcast_to(xs, (len(u), len(xs))),
                  np.broadcast_to(fpos[:, None], (len(u), len(xs))),
                  np.broadcast_to(zpos[:, None], (len(u), len(xs)))], -1)
    inside = hs.field(q.reshape(-1, 3)).reshape(len(u), len(xs)) < 0
    surf = xs[np.argmax(~inside, axis=1)]
    # lissage de la base (le relief du crâne ne doit pas onduler le pavillon)
    surf = np.full_like(surf, np.median(surf)) * 0.6 + surf * 0.4
    # décollement : l'arrière du pavillon (u < 0) s'écarte de la tête
    lateral = h + np.maximum(-u2, 0) * np.tan(flare) - 0.0015
    pos = np.stack([s * (surf + lateral), fpos, zpos], 1)
    if s < 0:
        faces = [f[::-1] for f in faces]
    # UV : projection dans le plan de l'oreille (île séparée)
    uvp = np.stack([(u + 0.03) / 0.06, (v + 0.035) / 0.07], 1)
    uv = [[tuple(uvp[i]) for i in f] for f in faces]
    return pos, faces, uv
