"""Rôles anatomiques des sommets de la peau (poids de mâchoire, paupières, lèvres),
calculés à partir de la topologie construite et stockés en attributs de sommets."""
import numpy as np

import head_shape as hs
import build_head as bh
import parts
import sdf


def lip_line_z(x):
    t = np.clip(x / hs.MOUTH_W, -1, 1)
    return hs.MOUTH_Z + 0.0010 * (1 - t * t) - 0.0016 * t ** 4


def compute(bm, loops, groups):
    """Retourne un dict nom → tableau (len(bm.verts)) de poids dans [0, 1]."""
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    n = len(bm.verts)
    P = np.array([v.co[:] for v in bm.verts])     # repère anatomique à ce stade
    x, f, z = P[:, 0], P[:, 1], P[:, 2]
    out = {}

    # --- lèvres ---------------------------------------------------------------------
    R = bh.MOUTH_RINGS
    rings = loops["rings"]["mouth"]
    ul = np.zeros(n)
    ll = np.zeros(n)
    upper0 = {v.index for v in loops["mouth_up"][1:-1]}
    lower0 = {v.index for v in loops["mouth_lo"][1:-1]}
    corners = {loops["mouth_up"][0].index, loops["mouth_up"][-1].index}
    for k, ring in enumerate(rings):
        w = (1 - k / (R + 2.0)) ** 1.2
        for v in ring:
            i = v.index
            if i in corners:
                ul[i] = ll[i] = 0.5 * w
            elif i in upper0 or (k > 0 and z[i] > lip_line_z(x[i])):
                ul[i] = w
            else:
                ll[i] = w
    side = groups["mouth_side"]
    for v, sd in side.items():
        i = v.index
        if sd > 0:
            ul[i] = 1.0
        elif sd < 0:
            ll[i] = 1.0
        else:
            ul[i] = ll[i] = 0.5
    out["lip_upper"], out["lip_lower"] = ul, ll

    # --- mâchoire : bas du visage sous la ligne des lèvres, devant la branche montante
    lat = np.maximum(np.abs(x) - hs.MOUTH_W, 0)
    zz = z + 0.55 * lat
    s1 = sdf.smoothstep(lip_line_z(x) + 0.003, lip_line_z(x) - 0.012, zz)
    s2 = sdf.smoothstep(-0.015, 0.030, f)
    # le cou ne suit pas la mâchoire
    s3 = 1 - sdf.smoothstep(-0.110, -0.135, z + 0.35 * np.maximum(0.05 - f, 0))
    jaw = s1 * s2 * s3
    # cheek/ramus: plus on s'éloigne latéralement, moins la peau suit
    jaw *= 1 - 0.6 * sdf.smoothstep(0.035, 0.060, np.abs(x)) * sdf.smoothstep(-0.02, 0.0, z - lip_line_z(x) + 0.02)
    jaw = np.maximum(jaw, ll)                      # lèvre inférieure et plancher buccal
    jaw = np.where(ul >= 0.99, 0.0, jaw)           # lèvre supérieure : jamais
    for i in corners:
        jaw[i] = 0.5
    out["jaw"] = np.clip(jaw, 0, 1)

    # --- paupières ------------------------------------------------------------------
    Re = bh.EYE_RINGS
    for s in (1, -1):
        c = hs.EYE_C * np.array([s, 1, 1])
        up = np.zeros(n)
        lo = np.zeros(n)
        mu = loops[f"eye{s}_up"]
        ml = loops[f"eye{s}_lo"]
        cm, cl = mu[0], mu[-1]
        a, b = P[cm.index], P[cl.index]
        rings_e = loops["rings"][f"eye{s}"]
        # anneaux au-delà du patch : on prolonge par voisinage pour une décroissance douce
        ext = [set(r) for r in rings_e]
        seen = set().union(*ext)
        for _ in range(3):
            nxt = {e.other_vert(v) for v in ext[-1] for e in v.link_edges} - seen
            seen |= nxt
            ext.append(nxt)
        for k, ring in enumerate(ext):
            w = max(0.0, 1 - k / (Re + 3.5)) ** 1.6
            for v in ring:
                i = v.index
                t = np.clip((abs(x[i]) - abs(a[0])) / (abs(b[0]) - abs(a[0])), 0, 1)
                zc = a[2] + (b[2] - a[2]) * t
                if v is cm or v is cl:
                    continue
                if z[i] > zc:
                    up[i] = max(up[i], w)
                else:
                    lo[i] = max(lo[i], w)
        for key, arr in ((f"lid_inner{s}", None), (f"fornix{s}", None)):
            for v in groups[key]:
                i = v.index
                t = np.clip((abs(x[i]) - abs(a[0])) / (abs(b[0]) - abs(a[0])), 0, 1)
                zc = a[2] + (b[2] - a[2]) * t
                if z[i] > zc + 0.0003:
                    up[i] = 1.0
                elif z[i] < zc - 0.0003:
                    lo[i] = 1.0
        # atténuation près des canthus (les coins restent fixes : pas de cisaillement)
        t = np.clip((np.abs(x) - abs(a[0])) / (abs(b[0]) - abs(a[0])), 0, 1)
        taper = sdf.smoothstep(0.0, 0.22, t) * (1 - sdf.smoothstep(0.80, 1.0, t))
        up *= 0.25 + 0.75 * taper
        lo *= 0.25 + 0.75 * taper
        tag = "L" if s > 0 else "R"
        out[f"lid_up_{tag}"], out[f"lid_lo_{tag}"] = up, lo
    return out
