"""Construction du maillage de la peau (tête + cou) en quads.

1. Sphère-cube en quads ; pendant les opérations topologiques, v.co contient la direction
   du sommet vue depuis le centre de projection C.
2. Yeux et bouche : insets successifs (boucles concentriques des orbiculaires), puis
   suppression du centre → ouvertures palpébrales et buccale.
3. Lissage des anneaux dans l'espace des directions, bords libres épinglés sur leurs
   courbes cibles, puis projection de chaque rayon sur le champ anatomique.
4. Extrusions internes : épaisseur des paupières et cul-de-sac conjonctival, intérieur des
   lèvres et sac buccal ; anneaux du cou.
"""
import numpy as np
import bmesh

import head_shape as hs
import sdf
import topo

BASE = np.array([0.0, 0.0, 1.60])          # position du repère anatomique dans Blender
C = np.array([0.0, -0.010, 0.050])         # centre de projection
N_CUBE = 34
FACE_AXIS = np.array([0.0, 0.11, -0.088])  # direction du centre du visage depuis C
FACE_DENSITY = 0.56                        # < 1 : resserre les quads sur le visage
PITCH = -14.0                              # face avant de la sphère-cube centrée sur le visage
EYE_RINGS = 4
MOUTH_RINGS = 5


# --- Courbes cibles (repère anatomique) ---------------------------------------------------
def eye_margin(s, t, upper):
    """Bord libre d'une paupière (œil gauche si s=1), t ∈ [0,1] du coin médial au latéral."""
    c = hs.EYE_C * np.array([s, 1, 1])
    mx, mz = 0.0170, 0.0188
    lx, lz = 0.0462, 0.0224
    x = mx + (lx - mx) * t
    z = mz + (lz - mz) * t
    if upper:
        z = z + 0.0045 * np.sin(np.pi * t ** 0.80)
    else:
        z = z - 0.0037 * np.sin(np.pi * t ** 1.20)
    r = hs.EYE_R + hs.LID_T
    dx = x - abs(c[0])
    dz = z - c[2]
    dy = np.sqrt(np.maximum(r * r - dx * dx - dz * dz, 0.0))
    # aux coins, hors de l'empreinte du globe : sur la surface vue de face, un peu en retrait
    xs = s * x * np.ones_like(t)
    surf = frontal_surface(np.stack([xs, z * np.ones_like(t)], -1)) - 0.0012
    w = sdf.smoothstep(0.0015, 0.0050, dy)
    f = (c[1] + dy) * w + np.minimum(surf, c[1] + dy + 0.004) * (1 - w)
    return np.stack([xs, f, z * np.ones_like(t)], -1)


def mouth_line(t):
    """Ligne de contact des lèvres, t ∈ [-1, 1] de la commissure droite à la gauche."""
    x = t * hs.MOUTH_W
    z = hs.MOUTH_Z + 0.0010 * (1 - t * t) - 0.0016 * t ** 4
    f = 0.0990 - 26.0 * x * x - 0.0025 * t ** 8
    return np.stack([x, f, z], -1)


def densify(d):
    """Rapproche les directions de l'axe du visage (plus de résolution à l'avant)."""
    a = FACE_AXIS / np.linalg.norm(FACE_AXIS)
    cos = np.clip(d @ a, -1, 1)
    th = np.arccos(cos)
    k = FACE_DENSITY
    th2 = th * (k + (1 - k) * th / np.pi)
    perp = d - cos[:, None] * a
    pn = np.linalg.norm(perp, axis=1, keepdims=True)
    perp = np.where(pn > 1e-9, perp / np.maximum(pn, 1e-9), 0)
    return np.cos(th2)[:, None] * a + np.sin(th2)[:, None] * perp


def frontal_surface(xz, f0=0.13, f1=0.04):
    """Profondeur f de la surface vue de face pour des points (x, z)."""
    fs = np.arange(f0, f1, -0.0005)
    pts = np.zeros((len(xz), len(fs), 3))
    pts[:, :, 0] = xz[:, None, 0]
    pts[:, :, 1] = fs[None, :]
    pts[:, :, 2] = xz[:, None, 1]
    v = hs.field(pts.reshape(-1, 3)).reshape(len(xz), len(fs))
    i = np.argmax(v < 0, axis=1)
    hi = fs[np.maximum(i - 1, 0)]
    lo = fs[i]
    for _ in range(12):
        mid = 0.5 * (hi + lo)
        q = np.stack([xz[:, 0], mid, xz[:, 1]], 1)
        inside = hs.field(q) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return 0.5 * (hi + lo)


def lip_crease(t):
    """Ligne de contact des lèvres sur la surface : pour chaque abscisse, point le plus en
    retrait du profil vertical (vu de face) autour du stomion ; aux commissures, le sillon
    s'efface et l'on garde la hauteur cible."""
    base = mouth_line(t)
    zs = np.linspace(-0.0025, 0.0025, 21)
    xz = np.stack([np.repeat(base[:, 0], len(zs)), (base[:, 2][:, None] + zs[None]).ravel()], 1)
    f = frontal_surface(xz).reshape(len(t), len(zs))
    i = np.argmin(f, axis=1)
    w = sdf.smoothstep(0.6, 0.9, np.abs(t))
    j = np.round(i * (1 - w) + (len(zs) // 2) * w).astype(int)
    z = base[:, 2] + zs[j]
    ff = f[np.arange(len(t)), j]
    return np.stack([base[:, 0], ff, z], 1)


def unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


# --- Outils bmesh ---------------------------------------------------------------------------
def ordered_loop(verts_edges):
    adj = {}
    for e in verts_edges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    start = next(iter(adj))
    loop, prev, cur = [start], None, start
    while True:
        nxt = [v for v in adj[cur] if v is not prev]
        if not nxt or nxt[0] is start or len(loop) > len(adj):
            break
        prev, cur = cur, nxt[0]
        loop.append(cur)
    return loop


def dir_for_point(p):
    return unit(np.atleast_2d(p) - C)


def project(dirs):
    t = hs.raycast(np.repeat(C[None], len(dirs), 0), dirs)
    return C + dirs * np.nan_to_num(t, nan=0.09)[:, None]


def gradient(p, h=2e-4, fn=None):
    fn = fn or hs.field
    g = np.zeros_like(p)
    for i in range(3):
        e = np.zeros(3)
        e[i] = h
        g[:, i] = (fn(p + e) - fn(p - e)) / (2 * h)
    return g


def snap(p, iters=3, fn=None):
    """Ramène des points sur la surface implicite (Newton le long du gradient)."""
    fn = fn or hs.field
    for _ in range(iters):
        f = fn(p)
        g = gradient(p, fn=fn)
        p = p - (f / np.maximum(np.sum(g * g, 1), 1e-8))[:, None] * g
    return p


def wrap_relax(bm, P, pinned, iters=25, lam=0.5, fn=None):
    """Relaxation sur la surface : lissage tangentiel puis reprojection. Répartit les
    sommets dans les zones que la projection radiale enjambait (surplombs)."""
    bm.verts.ensure_lookup_table()
    n = len(bm.verts)
    nbr = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    deg = np.array([len(x) for x in nbr])
    rows = np.repeat(np.arange(n), deg)
    cols = np.concatenate([x for x in nbr if x] or [[]]).astype(int)
    free = np.ones(n, bool)
    free[[v.index for v in pinned]] = False
    # sommets de bord (ouverture du cou) : glissent le long du bord seulement → figés ici
    for v in bm.verts:
        if v.is_boundary and v not in pinned:
            free[v.index] = False
    for _ in range(iters):
        avg = np.zeros_like(P)
        np.add.at(avg, rows, P[cols])
        avg /= np.maximum(deg, 1)[:, None]
        g = gradient(P, fn=fn)
        nrm = g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)
        delta = avg - P
        delta -= np.sum(delta * nrm, 1)[:, None] * nrm
        Q = P + lam * delta
        Q = snap(Q, 2, fn=fn)
        P = np.where(free[:, None], Q, P)
    return P


def inset_hole(bm, region, rings):
    """Insets répétés puis suppression du centre ; retourne la boucle du bord (ordonnée)."""
    for _ in range(rings):
        bmesh.ops.inset_region(bm, faces=region, thickness=0.006, depth=0.0, use_even_offset=True)
    rs = set(region)
    edges = {e for f in region for e in f.edges}
    border = [e for e in edges if sum(1 for lf in e.link_faces if lf in rs) == 1]
    loop = ordered_loop(border)
    bmesh.ops.delete(bm, geom=region, context="FACES")
    return loop


def grid_patch(bm, P, center, half_cols, rows_up, rows_down):
    """Patch rectangulaire de quads (2*half_cols colonnes × rows rangées) autour du point
    anatomique `center`, parcouru topologiquement (rangées de la grille, même courbes).
    Retourne (faces, sommet milieu du côté gauche, sommet milieu du côté droit)."""
    fc = lambda f: np.mean([P[v.index] for v in f.verts], 0)
    cands = list(bm.faces)
    if abs(center[0]) < 1e-6:   # patch centré : germe juste à droite de x = 0 (symétrie)
        cands = [f for f in cands if fc(f)[0] > 0]
    seed = min(cands, key=lambda f: np.sum((fc(f) - center) ** 2))
    em = lambda e: (P[e.verts[0].index] + P[e.verts[1].index]) / 2

    def across(f, e):
        return next((o for o in e.link_faces if o is not f), None)

    def opposite(f, e):
        es = list(f.edges)
        return es[(es.index(e) + 2) % 4]

    # rangée du germe : vers -x puis vers +x
    e_r = max(seed.edges, key=lambda e: (em(e) - fc(seed))[0])
    e_l = opposite(seed, e_r)

    def walk(f, e, n):
        faces, edges = [], []
        for _ in range(n):
            g = across(f, e)
            if g is None:
                break
            faces.append(g)
            edges.append(e)
            e = opposite(g, e)
            f = g
        return faces, edges

    # colonne supplémentaire côté -x, ou côté +x pour un patch à x < 0 (symétrie miroir)
    nl, nr_ = (half_cols, half_cols - 1) if center[0] >= 0 else (half_cols - 1, half_cols)
    lf, le = walk(seed, e_l, nl)
    rf, re_ = walk(seed, e_r, nr_)
    row = lf[::-1] + [seed] + rf
    shared = le[::-1] + re_          # arêtes entre faces consécutives de la rangée
    # côté « haut » du germe, puis propagation le long de la rangée
    sides = [e for e in seed.edges if e not in (e_l, e_r)]
    top_seed = max(sides, key=lambda e: em(e)[2])
    k0 = len(lf)
    tops = [None] * len(row)
    tops[k0] = top_seed
    for i in range(k0, len(row) - 1):
        sh = shared[i]
        v = next(x for x in sh.verts if x in tops[i].verts)
        tops[i + 1] = next(e for e in row[i + 1].edges if e is not sh and v in e.verts)
    for i in range(k0, 0, -1):
        sh = shared[i - 1]
        v = next(x for x in sh.verts if x in tops[i].verts)
        tops[i - 1] = next(e for e in row[i - 1].edges if e is not sh and v in e.verts)
    bots = [opposite(f, t) for f, t in zip(row, tops)]

    def next_row(faces, edges):
        nf = [across(f, e) for f, e in zip(faces, edges)]
        ne = [opposite(g, e) for g, e in zip(nf, edges)]
        return nf, ne

    rows = [row]
    cur_f, cur_e = row, tops
    ups = []
    for _ in range(rows_up):
        cur_f, cur_e = next_row(cur_f, cur_e)
        ups.append(cur_f)
    cur_f, cur_e = row, bots
    downs = []
    for _ in range(rows_down):
        cur_f, cur_e = next_row(cur_f, cur_e)
        downs.append(cur_f)
    ordered = ups[::-1] + [row] + downs          # de haut en bas
    patch = [f for r in ordered for f in r]
    # milieux des petits côtés : sommets communs aux faces d'extrémité des rangées
    # centrales (les rangées doivent être en nombre pair)
    nr = len(ordered)
    mid_a, mid_b = ordered[nr // 2 - 1], ordered[nr // 2]
    left = next(iter(set(mid_a[0].verts) & set(mid_b[0].verts)
                     - set(mid_a[1].verts) - set(mid_b[1].verts)))
    right = next(iter(set(mid_a[-1].verts) & set(mid_b[-1].verts)
                      - set(mid_a[-2].verts) - set(mid_b[-2].verts)))
    return patch, left, right


def split_loop(loop, key_a, key_b):
    """Coupe une boucle fermée entre les sommets minimisant key_a et key_b ; retourne
    les deux chemins (de a vers b)."""
    ia = min(range(len(loop)), key=lambda i: key_a(loop[i]))
    ib = min(range(len(loop)), key=lambda i: key_b(loop[i]))
    n = len(loop)
    p1 = [loop[(ia + k) % n] for k in range((ib - ia) % n + 1)]
    p2 = [loop[(ia - k) % n] for k in range((ia - ib) % n + 1)]
    return p1, p2


def split_at_mids(loop, mids, R):
    """Coupe la boucle intérieure en deux chemins (haut, bas) aux sommets reliés, par les
    chaînes d'inset, aux milieux des petits côtés du patch d'origine (anneau R). Les coins
    de l'anneau R sont ceux qui ont deux arêtes vers l'extérieur."""
    rings = [set(loop)]
    seen = set(loop)
    for _ in range(R):
        nxt = {e.other_vert(v) for v in rings[-1] for e in v.link_edges} - seen
        seen |= nxt
        rings.append(nxt)
    ringR = rings[R]
    edges = [e for v in ringR for e in v.link_edges if e.other_vert(v) in ringR]
    order = ordered_loop(list(set(edges)))
    m = len(order)
    out = [sum(1 for e in v.link_edges if e.other_vert(v) not in seen) for v in order]
    corners = [i for i in range(m) if out[i] >= 2]
    n = len(loop)
    if len(corners) == 4:
        sides = [(corners[i], corners[(i + 1) % 4]) for i in range(4)]
        short = sorted(sides, key=lambda sd: (sd[1] - sd[0]) % m)[:2]
        mids_r = [order[(a0 + ((a1 - a0) % m) // 2) % m] for a0, a1 in short]
    else:
        mids_r = [v for v in mids if v in ringR]
    ends = []
    for v in mids_r:
        for k in range(R - 1, -1, -1):
            v = next(e.other_vert(v) for e in v.link_edges if e.other_vert(v) in rings[k])
        ends.append(loop.index(v))
    ia = ends[0]
    ib = (ia + n // 2) % n
    q = lambda i: loop[i].co[0] / loop[i].co[1]
    if q(ib) < q(ia):
        ia, ib = ib, ia
    p1 = [loop[(ia + k) % n] for k in range((ib - ia) % n + 1)]
    p2 = [loop[(ia - k) % n] for k in range((ia - ib) % n + 1)]
    if np.mean([v.co[2] / v.co[1] for v in p1]) < np.mean([v.co[2] / v.co[1] for v in p2]):
        p1, p2 = p2, p1
    return p1, p2


def arclen(pts):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    return s / s[-1]


def relax(bm, pinned, region, iters=60, w=0.5):
    """Lissage laplacien des directions sur une région (sommets épinglés exclus)."""
    vs = [v for v in region if v not in pinned]
    nb = [[e.other_vert(v) for e in v.link_edges] for v in vs]
    for _ in range(iters):
        new = []
        for v, ns in zip(vs, nb):
            avg = sum((n.co for n in ns), v.co * 0) / len(ns)
            new.append(v.co.lerp(avg, w))
        for v, c in zip(vs, new):
            v.co = c.normalized()


def ring_region(seed, depth):
    """Sommets à une distance topologique ≤ depth d'une boucle."""
    seen = set(seed)
    front = list(seed)
    for _ in range(depth):
        nxt = []
        for v in front:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in seen:
                    seen.add(o)
                    nxt.append(o)
        front = nxt
    return seen


def build():
    d, faces = topo.cube_sphere(N_CUBE)
    d = d @ topo.rot_x(PITCH).T
    d = densify(d)
    bm = bmesh.new()
    for v in d:
        bm.verts.new(v)
    bm.verts.ensure_lookup_table()
    for f in faces:
        bm.faces.new([bm.verts[i] for i in f])

    def positions():
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        dirs = unit(np.array([v.co[:] for v in bm.verts]))
        return project(dirs)

    # ouverture inférieure (cou)
    bottom = [f for f in bm.faces if f.calc_center_median().normalized()[2] < -0.93]
    bmesh.ops.delete(bm, geom=bottom, context="FACES")

    P = positions()
    loops = {}
    for s in (1, -1):
        sel, ml, mr = grid_patch(bm, P, np.array([s * 0.0316, 0.08, 0.0206]), 8, 4, 3)
        loops[f"eye{s}"] = inset_hole(bm, sel, EYE_RINGS)
        loops[f"eye{s}_mids"] = (ml, mr)
        P = positions()
    sel, ml, mr = grid_patch(bm, P, np.array([0.0, 0.10, hs.MOUTH_Z]), 14, 2, 3)
    loops["mouth"] = inset_hole(bm, sel, MOUTH_RINGS)
    loops["mouth_mids"] = (ml, mr)
    P = positions()

    # --- bords libres sur leurs courbes cibles -------------------------------------------
    targets = {}
    for s in (1, -1):
        loop = loops[f"eye{s}"]
        up, lo = split_at_mids(loop, loops[f"eye{s}_mids"], EYE_RINGS)
        if s < 0:  # œil droit : du coin médial (x proche de 0) au latéral
            up, lo = up[::-1], lo[::-1]
        for path, upper in ((up, True), (lo, False)):
            pts = eye_margin(s, np.linspace(0, 1, len(path)), upper)
            for v, p in zip(path, pts):
                targets[v] = p
        loops[f"eye{s}_up"], loops[f"eye{s}_lo"] = up, lo
    loop = loops["mouth"]
    up, lo = split_at_mids(loop, loops["mouth_mids"], MOUTH_RINGS)
    for path in (up, lo):
        pts = lip_crease(np.linspace(-1, 1, len(path)))
        for v, p in zip(path, pts):
            targets[v] = p
    loops["mouth_up"], loops["mouth_lo"] = up, lo

    # --- anneaux : interpolation entre le bord libre et le bord du patch -----------------
    rings_of = {}
    chains = {}
    for key, R in (("eye1", EYE_RINGS), ("eye-1", EYE_RINGS), ("mouth", MOUTH_RINGS)):
        rings = [set(loops[key])]
        seen = set(loops[key])
        for _ in range(R):
            nxt = {e.other_vert(v) for v in rings[-1] for e in v.link_edges} - seen
            seen |= nxt
            rings.append(nxt)
        rings_of[key] = rings
        dir0 = {}
        for v in rings[0]:
            p = targets[v]
            d0 = dir_for_point(p)[0]
            if key == "mouth":
                # lèvres jointes : directions légèrement séparées pour l'interpolation
                d0 = unit(d0 + np.array([0, 0, 0.002 if v in set(loops["mouth_up"][1:-1]) else
                                          (-0.002 if v in set(loops["mouth_lo"][1:-1]) else 0)]))
            dir0[v] = d0
        # chaînes : chaque sommet d'anneau k a un unique voisin dans l'anneau k+1
        done = set()
        for v0 in rings[0]:
            chain = [v0]
            for k in range(1, R + 1):
                cand = [e.other_vert(chain[-1]) for e in chain[-1].link_edges]
                cand = [c for c in cand if c in rings[k]]
                if not cand:
                    break
                chain.append(cand[0])
            if len(chain) != R + 1:
                continue
            chains.setdefault(key, []).append(chain)
            dR = np.array(chain[-1].co[:])
            for k in range(1, R):
                t = k / R
                chain[k].co = unit(dir0[v0] * (1 - t) + dR * t)
                done.add(chain[k])
            v0.co = dir0[v0]
        for v0 in rings[0]:
            v0.co = dir0[v0]
        # sommets d'anneaux sans chaîne complète (coins du patch) : moyenne des voisins
        orphans = [v for k in range(1, R) for v in rings[k] if v not in done]
        for _ in range(60):
            for v in orphans:
                ns = [e.other_vert(v) for e in v.link_edges]
                v.co = (sum((n.co for n in ns), v.co * 0) / len(ns)).normalized()
        # lissage harmonique des anneaux intermédiaires (bords 0 et R fixes)
        mids = [v for k in range(1, R) for v in rings[k]]
        nbs = [[e.other_vert(v) for e in v.link_edges] for v in mids]
        for _ in range(300):
            new = [sum((n.co for n in ns), v.co * 0) / len(ns) for v, ns in zip(mids, nbs)]
            for v, c in zip(mids, new):
                v.co = v.co.lerp(c, 0.8).normalized()
    loops["rings"] = rings_of

    # lissage final : adoucit la transition anneaux / grille (bords libres épinglés)
    for key, R in (("eye1", EYE_RINGS), ("eye-1", EYE_RINGS), ("mouth", MOUTH_RINGS)):
        reg = ring_region(loops[key], R + 4)
        outer = reg - ring_region(loops[key], R + 3)
        inner = ring_region(loops[key], R - 1)
        relax(bm, inner | outer, reg, iters=40, w=0.4)

    P = positions()
    for v, p in targets.items():
        P[v.index] = p
    # yeux : l'arcade masque le sillon palpébral depuis C. Les anneaux sont replacés par
    # relaxation harmonique sur la surface (bord libre et un anneau de grille extérieur fixes)
    bm.verts.ensure_lookup_table()
    for key in ("eye1", "eye-1"):
        R = EYE_RINGS
        reg = ring_region(loops[key], R + 3)
        outer = reg - ring_region(loops[key], R + 2)
        fixed = set(loops[key]) | outer
        free = [v for v in reg if v not in fixed]
        fi = np.array([v.index for v in free])
        nb = [np.array([e.other_vert(v).index for e in v.link_edges]) for v in free]
        for it in range(160):
            avg = np.array([P[n].mean(0) for n in nb])
            P[fi] = P[fi] * 0.3 + avg * 0.7
            if it % 4 == 3 or it == 159:
                P[fi] = snap(P[fi], 2)
    # les anneaux internes des paupières et des lèvres restent ceux de la projection ;
    # le reste glisse sur la surface
    keep = set(targets)
    for key in ("eye1", "eye-1", "mouth"):
        for ring in loops["rings"][key]:
            keep |= ring
    P = wrap_relax(bm, P, keep)
    return bm, loops, P
