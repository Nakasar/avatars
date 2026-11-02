"""Finition du maillage de peau : extrusions internes (paupières, lèvres, sac buccal) et cou.

Toutes les positions sont dans le repère anatomique (voir sdf.py).
"""
import numpy as np
import bmesh
from mathutils import Vector, Matrix

import head_shape as hs
import build_head as bh

NECK_END_Z = -0.205        # bas du cou (caché sous le col du t-shirt)
NECK_AXIS_F = -0.017


def loop_edges(loop):
    s = set(loop)
    edges = []
    for v in loop:
        for e in v.link_edges:
            if e.other_vert(v) in s and e.is_boundary and e not in edges:
                edges.append(e)
    return edges


def extrude_loop(bm, loop, fn):
    """Extrude une boucle de bord ; fn(ancien sommet) → nouvelle position. Retourne la
    nouvelle boucle (même ordre)."""
    res = bmesh.ops.extrude_edge_only(bm, edges=loop_edges(loop))
    new_verts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    # correspondance ancien → nouveau via l'arête d'extrusion
    newset = set(new_verts)
    out = []
    for v in loop:
        nv = next(e.other_vert(v) for e in v.link_edges if e.other_vert(v) in newset)
        nv.co = Vector(fn(v))
        out.append(nv)
    return out


def finish(bm, loops, P):
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        v.co = Vector(P[v.index])
    groups = {}

    # --- paupières : bord intérieur contre le globe, puis cul-de-sac derrière ---------
    for s in (1, -1):
        c = Vector(hs.EYE_C * np.array([s, 1, 1]))
        loop = loops[f"eye{s}_up"] + loops[f"eye{s}_lo"][1:-1][::-1]
        centre = sum((v.co for v in loop), Vector()) / len(loop)
        axis_open = (centre - c).normalized()

        def clamp_move(p, t, limit):
            delta = t - p
            if delta.length > limit:
                delta *= limit / delta.length
            return p + delta

        def waterline(v):
            d = (v.co - c).normalized()
            # légèrement vers l'arrière pour que le bord épais se lise
            d = (d - axis_open * 0.06).normalized()
            # aux canthus (hors du globe) on limite le déplacement : pas d'éventail
            return clamp_move(v.co, c + d * (hs.EYE_R + 0.00035), 0.0016)

        inner = extrude_loop(bm, loop, waterline)

        def fornix(v):
            d = (v.co - c).normalized()
            ax = axis_open.cross(d)
            if ax.length < 1e-6:
                ax = Vector((0, 0, 1))
            rot = Matrix.Rotation(np.radians(38), 3, ax.normalized())
            return clamp_move(v.co, c + (rot @ d) * (hs.EYE_R + 0.0008), 0.0045)

        fx = extrude_loop(bm, inner, fornix)
        groups[f"lid_inner{s}"] = inner
        groups[f"fornix{s}"] = fx

    # --- lèvres : face interne puis sac buccal ------------------------------------------
    up = loops["mouth_up"]
    lo = loops["mouth_lo"]
    loop = up + lo[1:-1][::-1]
    upset = set(up[1:-1])
    loset = set(lo[1:-1])

    def side(v):
        return 1.0 if v in upset else (-1.0 if v in loset else 0.0)

    def mucosa(v):
        p = np.array(v.co[:])
        return p + np.array([0, -0.0038, 0.0024 * side(v)])

    r1 = extrude_loop(bm, loop, mucosa)
    sides = {nv: side(v) for v, nv in zip(loop, r1)}

    def gum(v):
        p = np.array(v.co[:])
        return p + np.array([0.02 * p[0], -0.0035, 0.0095 * sides[v]])

    r2 = extrude_loop(bm, r1, gum)
    sides.update({nv: sides[v] for v, nv in zip(r1, r2)})

    def bag(v):
        p = np.array(v.co[:])
        return np.array([p[0] * 1.05, p[1] - 0.030, hs.MOUTH_Z + 0.002 + 0.016 * sides[v]])

    r3 = extrude_loop(bm, r2, bag)
    sides.update({nv: sides[v] for v, nv in zip(r2, r3)})

    def back(v):
        p = np.array(v.co[:])
        return np.array([p[0] * 0.55, p[1] - 0.020, p[2] - 0.003 * sides[v]])

    r4 = extrude_loop(bm, r3, back)
    bmesh.ops.contextual_create(bm, geom=loop_edges(r4))
    groups["mouth_r1"], groups["mouth_r2"], groups["mouth_r3"], groups["mouth_r4"] = r1, r2, r3, r4
    groups["mouth_side"] = {v: sd for v, sd in sides.items()}
    for v in r4:
        groups["mouth_side"][v] = sides.get(v, 0.0)

    # --- cou : anneaux sous l'ouverture inférieure ---------------------------------------
    border = [e for e in bm.edges if e.is_boundary]
    known = set(loop_edges(r4))
    for s in (1, -1):
        known |= set(loop_edges(groups[f"fornix{s}"]))
    border = [e for e in border if e not in known]
    neck = bh.ordered_loop(border)
    ring = neck
    n_rings = 9
    z0 = np.array([v.co[2] for v in neck])
    ang = np.array([np.arctan2(v.co[0], v.co[1] - NECK_AXIS_F) for v in neck])
    for k in range(1, n_rings + 1):
        t = k / n_rings
        z = z0 + (NECK_END_Z - z0) * (1 - (1 - t) ** 1.3)
        o = np.stack([np.zeros_like(z), np.full_like(z, NECK_AXIS_F), z], 1)
        # rayons inclinés vers le bas : ils frappent la pente des trapèzes moins en biais
        d = np.stack([np.sin(ang), np.cos(ang), np.full_like(z, -0.45 * t)], 1)
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        tt = hs.raycast(o, d, t_max=0.16, step=0.0015)
        pts = o + d * np.nan_to_num(tt, nan=0.06)[:, None]
        it = iter(pts)
        ring = extrude_loop(bm, ring, lambda v: next(it))
    groups["neck_end"] = ring
    # relaxation sur la surface des anneaux du cou (le reste est figé)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    P = np.array([v.co[:] for v in bm.verts])
    ring_set = set(ring)
    free = {v for v in bm.verts if v.co.z < -0.085 and v not in ring_set}
    frozen = set(bm.verts) - free
    P = bh.wrap_relax(bm, P, frozen, iters=40, lam=0.5)
    for v in bm.verts:
        v.co = Vector(P[v.index])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    orient_outward(bm, set().union(*[set(groups[k]) for k in (
        "lid_inner1", "lid_inner-1", "fornix1", "fornix-1", "mouth_r1", "mouth_r2", "mouth_r3", "mouth_r4")]))
    # bords libres (lèvres, paupières) en arêtes vives : normales séparées peau / muqueuse
    for lp in (loops["mouth_up"], loops["mouth_lo"], loops["eye1_up"], loops["eye1_lo"],
               loops["eye-1_up"], loops["eye-1_lo"]):
        for e in loop_edges_any(lp):
            e.smooth = False
    return groups


def loop_edges_any(path):
    s = set(path)
    out = set()
    for v in path:
        for e in v.link_edges:
            if e.other_vert(v) in s:
                out.add(e)
    return out


def orient_outward(bm, interior):
    """Oriente les normales de la peau vers l'extérieur (test sur les faces externes)."""
    c = Vector((0.0, 0.0, 0.0))
    score = 0.0
    for f in bm.faces:
        if any(v in interior for v in f.verts):
            continue
        fc = f.calc_center_median()
        if fc.z < -0.10:
            continue
        score += (fc - c).normalized().dot(f.normal)
    if score < 0:
        for f in bm.faces:
            f.normal_flip()
    bm.normal_update()
