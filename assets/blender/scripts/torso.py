"""Buste habillé : t-shirt à col rond posé sur un champ de torse (repère anatomique)."""
import numpy as np
import bmesh
from mathutils import Vector

import head_shape as hs
import build_head as bh
import build_body as bb
import topo
import sdf
from sdf import smin, smax, ellipsoid, sphere, cone_capsule

T_CENTER = np.array([0.0, -0.022, -0.275])
BOTTOM_Z = -0.47
OFFSET = 0.0045          # épaisseur / aisance du tissu au-dessus de la peau


def body_field(p):
    d = ellipsoid(p, (0, -0.014, -0.345), (0.148, 0.104, 0.20))
    d = smin(d, ellipsoid(p, (0, 0.004, -0.300), (0.130, 0.092, 0.105)), 0.03)
    for s in (-1, 1):
        d = smin(d, sphere(p, (s * 0.186, -0.018, -0.217), 0.052), 0.035)
        d = smin(d, cone_capsule(p, (s * 0.198, -0.020, -0.225), (s * 0.222, -0.026, -0.52), 0.049, 0.043), 0.03)
    d = smin(d, hs.neck(p), 0.03)
    return d


def shirt_field(p):
    d = body_field(p) - OFFSET
    return smax(d, BOTTOM_Z - p[..., 2], 0.004)


NECK_PHI = [0.0, 0.6, 1.2, 1.9, 2.5, np.pi]
NECK_Z = [-0.168, -0.162, -0.148, -0.134, -0.126, -0.124]


def collar_z(p):
    phi = np.abs(np.arctan2(p[..., 0], p[..., 1] + 0.017))
    return sdf.pchip(NECK_PHI, NECK_Z, phi)


def build(n=26):
    d, faces = topo.cube_sphere(n)
    bm = bmesh.new()
    for v in d:
        bm.verts.new(v)
    bm.verts.ensure_lookup_table()
    for f in faces:
        bm.faces.new([bm.verts[i] for i in f])
    bm.verts.index_update()
    dirs = np.array([v.co[:] for v in bm.verts])
    t = hs.raycast(np.repeat(T_CENTER[None], len(dirs), 0), dirs, fn=shirt_field, t_max=0.5, step=0.003)
    P = T_CENTER + dirs * np.nan_to_num(t, nan=0.2)[:, None]
    # suppression : au-dessus du col et sous le bas du buste
    kill = []
    for f in bm.faces:
        c = np.mean([P[v.index] for v in f.verts], 0)
        if c[2] > collar_z(c) or c[2] < BOTTOM_Z + 0.002:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    dirs = np.array([v.co[:] for v in bm.verts])
    t = hs.raycast(np.repeat(T_CENTER[None], len(dirs), 0), dirs, fn=shirt_field, t_max=0.5, step=0.003)
    P = T_CENTER + dirs * np.nan_to_num(t, nan=0.2)[:, None]
    # bord du col recalé sur la courbe d'encolure (rayons horizontaux depuis l'axe du cou)
    border = [e for e in bm.edges if e.is_boundary and P[e.verts[0].index][2] > -0.3]
    loop = bh.ordered_loop(border)
    idx = np.array([v.index for v in loop])
    q = P[idx]
    ang = np.arctan2(q[:, 0], q[:, 1] + 0.017)
    # répartition régulière en angle (le bord en escalier devient une courbe propre)
    order = np.argsort(ang)
    ang_s = np.linspace(-np.pi, np.pi, len(loop), endpoint=False) + np.pi / len(loop)
    ang_new = np.empty_like(ang)
    ang_new[order] = ang_s
    dd = np.stack([np.sin(ang_new), np.cos(ang_new), np.zeros_like(ang_new)], 1)
    zc = collar_z(np.stack([dd[:, 0], dd[:, 1], np.zeros_like(ang_new)], 1) * 0.05 + np.array([0, -0.017, 0]))
    o = np.stack([np.zeros_like(zc), np.full_like(zc, -0.017), zc], 1)
    tt = hs.raycast(o, dd, fn=shirt_field, t_max=0.15, step=0.0015)
    P[idx] = o + dd * np.nan_to_num(tt, nan=0.07)[:, None]
    P = bh.wrap_relax(bm, P, set(loop), iters=30, fn=shirt_field)
    for v in bm.verts:
        v.co = Vector(P[v.index])

    def rib_in(v):
        p = np.array(v.co[:])
        axis = np.array([0, -0.017, p[2]])
        r = p - axis
        return p - r / np.linalg.norm(r) * 0.0035 + np.array([0, 0, 0.0015])

    l1 = bb.extrude_loop(bm, loop, rib_in)

    def rib_down(v):
        return np.array(v.co[:]) + np.array([0, 0, -0.010])

    bb.extrude_loop(bm, l1, rib_down)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    verts = np.array([v.co[:] for v in bm.verts])
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return verts, faces
