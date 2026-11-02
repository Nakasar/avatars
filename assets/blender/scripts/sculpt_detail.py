"""Sculpture du détail au pinceau, dans Blender (interface graphique requise).

À exécuter dans une instance graphique de Blender (par exemple via l'addon MCP) après un
build de la pipeline :

    import sculpt_detail; sculpt_detail.run(r"chemin/vers/build.blend")

1. Copie de la peau sans ses faces internes, modifier Multiresolution niveau 2, calée
   (multires_reshape) sur la copie haute résolution de la pipeline (champ + rides).
2. Vrais coups de brosse du mode Sculpt (bpy.ops.sculpt.brush_stroke) au niveau 2 :
   chaque trait est une polyligne posée sur des repères anatomiques, projetée à l'écran
   depuis une vue de face ou de profil.
3. Le détail sculpté est enregistré comme déplacement des sommets du niveau 2
   (assets/blender/sculpt/detail_delta.npz) ; la pipeline le réapplique à sa copie haute
   résolution avant de cuire la normal map. Le maillage temps réel et la topologie des
   shape keys ne changent pas.
"""
import os
import sys

import numpy as np
import bpy
from bpy_extras import view3d_utils
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in dir() else r"D:\DEV\AVATARS\assets\blender\scripts"
sys.path.insert(0, HERE)
import topo  # noqa: E402
import head_shape as hs  # noqa: E402

BASE = np.array([0.0, 0.0, 1.60])
STRENGTH_SCALE = 0.45   # forces des traits (réglées à l'œil sur les rendus de contrôle)
OUT = os.path.normpath(os.path.join(HERE, "..", "sculpt", "detail_delta.npz"))
LIB = os.path.join(os.path.dirname(bpy.app.binary_path), "5.2", "datafiles", "assets", "brushes",
                   "essentials_brushes-mesh_sculpt.blend")


def bl(p):
    return Vector(topo.to_blender(np.asarray(p, float), BASE).tolist())


def mirror(pts):
    return [(-x, f, z) for x, f, z in pts]


def resample(pts, step):
    """Points régulièrement espacés (m) le long d'une polyligne."""
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(int(s[-1] / step), 2)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, pts[:, i]) for i in range(3)], 1)


# --- Traits : (brosse, polyligne anatomique, rayon (m), force, direction, vue, symétrique)
def strokes():
    S = []

    def add(brush, pts, r, strength, sub=False, view="FRONT", sym=True):
        S.append((brush, pts, r, strength, sub, view))
        if sym:
            S.append((brush, mirror(pts), r, strength, sub, "LEFT" if view == "RIGHT" else view))

    # 1. paupières : pli supérieur net, bord libre épaissi, poche inférieure, canthus
    add("Crease Sharp", [(0.0205, 0.0815, 0.0272), (0.0300, 0.0835, 0.0305), (0.0400, 0.0805, 0.0298),
                         (0.0470, 0.0745, 0.0262)], 0.0014, 0.55)
    add("Draw Sharp", [(0.0215, 0.0835, 0.0245), (0.0310, 0.0855, 0.0262), (0.0420, 0.0815, 0.0250)],
        0.0012, 0.25)                                                      # bord de la paupière supérieure
    add("Inflate/Deflate", [(0.0230, 0.0835, 0.0130), (0.0320, 0.0850, 0.0120), (0.0420, 0.0810, 0.0145)],
        0.0022, 0.30)                                                      # bourrelet prétarsal
    add("Crease Sharp", [(0.0215, 0.0840, 0.0105), (0.0320, 0.0835, 0.0080), (0.0430, 0.0790, 0.0095)],
        0.0016, 0.30)                                                      # pli sous la poche
    add("Crease Sharp", [(0.0160, 0.0800, 0.0200), (0.0175, 0.0805, 0.0170)], 0.0010, 0.35)  # canthus médial
    # 2. lèvres : volume du vermillon, philtrum, commissures, stries verticales
    add("Inflate/Deflate", [(0.0040, 0.1005, -0.0410), (0.0120, 0.0975, -0.0425), (0.0200, 0.0915, -0.0445)],
        0.0030, 0.20)                                                      # lèvre supérieure
    add("Inflate/Deflate", [(0.0040, 0.1000, -0.0530), (0.0120, 0.0975, -0.0525), (0.0190, 0.0920, -0.0510)],
        0.0034, 0.25)                                                      # lèvre inférieure
    add("Crease Sharp", [(0.0000, 0.1010, -0.0390), (0.0000, 0.1005, -0.0260)], 0.0018, 0.25, sym=False)  # gouttière
    add("Crease Sharp", [(0.0245, 0.0880, -0.0450), (0.0275, 0.0860, -0.0490)], 0.0012, 0.45)  # commissure
    for x in (0.002, 0.005, 0.008, 0.011, 0.014, 0.017):
        add("Crease Sharp", [(x, 0.101 - 26 * x * x, -0.0400), (x, 0.101 - 26 * x * x, -0.0455)], 0.0005, 0.20)
        add("Crease Sharp", [(x, 0.1005 - 26 * x * x, -0.0490), (x, 0.1005 - 26 * x * x, -0.0560)], 0.0005, 0.20)
    # 3. nez : sillon alaire, bord des narines, dos du nez, pointe
    add("Crease Sharp", [(0.0200, 0.0950, -0.0110), (0.0215, 0.0935, -0.0160), (0.0200, 0.0935, -0.0215),
                         (0.0165, 0.0960, -0.0240)], 0.0012, 0.55)
    add("Draw Sharp", [(0.0, 0.1000, 0.0150), (0.0, 0.1060, -0.0030)], 0.0018, 0.15, sym=False)  # arête du nez
    add("Inflate/Deflate", [(0.0030, 0.1100, -0.0130)], 0.0035, 0.15)     # lobule de la pointe
    add("Crease Sharp", [(0.0040, 0.1040, -0.0225), (0.0090, 0.1020, -0.0235)], 0.0009, 0.35)  # bord des narines
    # 4. pommettes, sillons naso-géniens, mâchoire, menton
    add("Crease Sharp", [(0.0220, 0.0935, -0.0185), (0.0285, 0.0915, -0.0330), (0.0330, 0.0870, -0.0480)],
        0.0020, 0.35)
    add("Inflate/Deflate", [(0.0320, 0.0890, -0.0250), (0.0370, 0.0860, -0.0380)], 0.0055, 0.15)
    add("Crease Sharp", [(-0.008, 0.0930, -0.0630), (0.008, 0.0930, -0.0630)], 0.0030, 0.30, sym=False)  # sillon mento-labial
    add("Draw Sharp", [(0.0500, 0.0040, -0.0600), (0.0350, 0.0550, -0.0780), (0.0200, 0.0800, -0.0870)],
        0.0030, 0.20, view="RIGHT")                                         # bord de la mâchoire
    # 5. front, tempes, oreilles, cou
    for z, a in ((0.060, 0.35), (0.069, 0.30), (0.078, 0.22)):
        add("Crease Sharp", [(0.000, 0.0985, z), (0.018, 0.0955, z + 0.0015), (0.034, 0.0890, z - 0.001)],
            0.0010, a)                                                      # rides du front
    for k in range(3):
        add("Crease Sharp", [(0.0505, 0.0700, 0.0140 + 0.006 * k), (0.0575, 0.0640, 0.0155 + 0.007 * k)],
            0.0007, 0.30)                                                   # pattes d'oie
    add("Crease Sharp", [(0.0790, -0.0240, 0.0300), (0.0840, -0.0180, 0.0050), (0.0800, -0.0130, -0.0150)],
        0.0018, 0.45, view="RIGHT")                                         # creux de la scapha (oreille)
    add("Draw Sharp", [(0.0840, -0.0030, 0.0280), (0.0880, -0.0120, 0.0080)], 0.0018, 0.30, view="RIGHT")  # anthélix
    add("Draw Sharp", [(0.0450, 0.0050, -0.0600), (0.0300, 0.0300, -0.1100), (0.0150, 0.0450, -0.1500)],
        0.0060, 0.18, view="RIGHT")                                         # sterno-cléido-mastoïdien
    # 6. asymétries : pli palpébral droit un peu plus bas, commissure gauche un peu relevée
    S.append(("Crease Sharp", mirror([(0.0220, 0.0820, 0.0262), (0.0330, 0.0840, 0.0292)]), 0.0012, 0.25, False, "FRONT"))
    S.append(("Draw Sharp", [(0.0230, 0.0890, -0.0435), (0.0260, 0.0875, -0.0445)], 0.0015, 0.15, False, "FRONT"))
    return S


# --- Préparation -----------------------------------------------------------------------
def view_ctx():
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == "VIEW_3D")
    region = next(r for r in area.regions if r.type == "WINDOW")
    return win, area, region, area.spaces.active.region_3d


def prepare(src_name="Body"):
    """Copie multirésolution de la peau, calée sur la copie haute résolution."""
    import build_avatar as ba
    body = bpy.data.objects[src_name]
    hi = ba.high_res_copy(body, apply_detail=False)  # même construction que la pipeline
    det = body.copy()
    det.data = body.data.copy()
    det.name = "SculptDetail"
    det.data.name = "SculptDetail"
    bpy.context.scene.collection.objects.link(det)
    det.modifiers.clear()
    det.parent = None
    if det.data.shape_keys:
        det.shape_key_clear()
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(det.data)
    inner = bm.verts.layers.float.get("interior")
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if any(v[inner] > 0.5 for v in f.verts)], context="FACES")
    bm.to_mesh(det.data)
    bm.free()
    win, area, region, rv3d = view_ctx()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
        o.hide_set(o not in (det, hi))
    bpy.context.view_layer.objects.active = det
    det.select_set(True)
    mod = det.modifiers.new("Multires", "MULTIRES")
    with bpy.context.temp_override(window=win, area=area, region=region, object=det, active_object=det):
        for _ in range(2):
            bpy.ops.object.multires_subdivide(modifier="Multires", mode="CATMULL_CLARK")
        hi.select_set(True)
        det.select_set(True)
        bpy.context.view_layer.objects.active = det
        bpy.ops.object.multires_reshape(modifier="Multires")
    ref = np.array([v.co[:] for v in hi.data.vertices])
    bpy.data.objects.remove(hi)
    return det, ref


def evaluated(det):
    dg = bpy.context.evaluated_depsgraph_get()
    me = det.evaluated_get(dg).to_mesh()
    co = np.array([v.co[:] for v in me.vertices])
    det.evaluated_get(dg).to_mesh_clear()
    return co


def set_view(view, target):
    win, area, region, rv3d = view_ctx()
    with bpy.context.temp_override(window=win, area=area, region=region):
        bpy.ops.view3d.view_axis(type=view)
    rv3d.view_perspective = "ORTHO"
    rv3d.view_location = target
    rv3d.view_distance = 0.16


def activate(brush):
    win, area, region, rv3d = view_ctx()
    with bpy.context.temp_override(window=win, area=area, region=region):
        bpy.ops.brush.asset_activate(asset_library_type="ESSENTIALS", asset_library_identifier="",
                                     relative_asset_identifier=f"brushes/essentials_brushes-mesh_sculpt.blend/Brush/{brush}")
    return bpy.context.tool_settings.sculpt.brush


def stroke(brush, pts, r, strength, sub, view):
    win, area, region, rv3d = view_ctx()
    P = resample(pts, r * 1.0)                         # une touche par rayon
    centre = bl(P.mean(0))
    set_view(view, centre)
    b = activate(brush)
    b.strength = strength * STRENGTH_SCALE
    if hasattr(b, "direction"):
        dirs = [e.identifier for e in b.bl_rna.properties["direction"].enum_items]
        b.direction = dirs[1] if sub else dirs[0]          # ADD/SUBTRACT, INFLATE/DEFLATE…
    # rayon en pixels : distance écran de deux points espacés de r
    a0 = view3d_utils.location_3d_to_region_2d(region, rv3d, centre)
    a1 = view3d_utils.location_3d_to_region_2d(region, rv3d, centre + Vector((0, 0, r)))
    px = max((a1 - a0).length, 2.0)
    ups = bpy.context.tool_settings.sculpt.unified_paint_settings
    ups.size = int(px)
    b.size = int(px)
    elems = []
    for i, p in enumerate(P):
        m = view3d_utils.location_3d_to_region_2d(region, rv3d, bl(p))
        if m is None:
            continue
        elems.append({"name": "", "location": bl(p), "mouse": m, "mouse_event": m, "is_start": i == 0,
                      "pressure": 1.0, "size": px, "time": i * 0.01, "x_tilt": 0.0, "y_tilt": 0.0})
    with bpy.context.temp_override(window=win, area=area, region=region):
        bpy.ops.sculpt.brush_stroke(stroke=elems, mode="NORMAL")


def run(blend=None, only=None):
    """Joue tous les traits (ou les indices `only`) et enregistre le détail sculpté."""
    if blend:
        bpy.ops.wm.open_mainfile(filepath=blend)
    det, ref = prepare()
    win, area, region, rv3d = view_ctx()
    with bpy.context.temp_override(window=win, area=area, region=region, object=det, active_object=det):
        bpy.ops.object.mode_set(mode="SCULPT")
    det.modifiers["Multires"].sculpt_levels = 2
    errors = []
    for i, s in enumerate(strokes()):
        if only is not None and i not in only:
            continue
        try:
            stroke(*s)
        except Exception as e:  # un trait raté ne doit pas perdre toute la séance
            errors.append((i, s[0], str(e)[:100]))
    with bpy.context.temp_override(window=win, area=area, region=region, object=det, active_object=det):
        bpy.ops.object.mode_set(mode="OBJECT")
    co = evaluated(det)
    if len(co) != len(ref):
        raise RuntimeError(f"topologie différente : {len(co)} / {len(ref)}")
    delta = (co - ref).astype(np.float32)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    np.savez_compressed(OUT, delta=delta)
    return {"verts": len(co), "max_mm": float(np.abs(delta).max() * 1000),
            "moved": int((np.abs(delta).max(1) > 1e-5).sum()), "errors": errors}
