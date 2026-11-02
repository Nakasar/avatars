"""UV et matériaux PBR (compatibles export glTF)."""
import numpy as np
import bmesh
import bpy

import head_shape as hs
import topo
import build_head as bh

BASE = bh.BASE


# --- UV ---------------------------------------------------------------------------------
FACE_REGIONS = (1, 3)   # visage + intérieurs (paupières, bouche) → atlas du visage (4K)


def unwrap_body(body):
    """Coutures : pourtour du visage, bords libres (paupières, lèvres), dos du crâne et du
    cou, oreilles (îles séparées). Deux groupes empaquetés séparément : le visage (matériau
    « Face », atlas 4K) et le reste (matériau « Skin », 2K). Index de matériau mis à jour."""
    me = body.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    P = topo.from_blender(np.array([v.co[:] for v in bm.verts]), BASE)
    field = hs.field(P)
    inner = np.zeros(len(me.vertices))
    if "interior" in me.attributes:
        me.attributes["interior"].data.foreach_get("value", inner)

    def region(p, fv, inn):
        x, f, z = p
        if inn > 0.5:                     # intérieurs (bouche, paupières)
            return 3
        if abs(x) > 0.066 and f < 0.03 and -0.03 < z < 0.05 and fv > 0.0015:
            return 4                      # oreilles (hors surface du crâne)
        if f > 0.035 and z > -0.112 and z < 0.098 and abs(x) < 0.066:
            return 1                      # visage
        return 2                          # crâne, cou

    freg = {}
    for fc in bm.faces:
        ps = np.array([P[v.index] for v in fc.verts])
        fv = np.array([field[v.index] for v in fc.verts])
        inn = np.array([inner[v.index] for v in fc.verts])
        freg[fc.index] = region(ps.mean(0), fv.mean(), inn.max())
    for e in bm.edges:
        rs = {freg[f.index] for f in e.link_faces}
        seam = len(rs) > 1
        a, b = P[e.verts[0].index], P[e.verts[1].index]
        # couture verticale à l'arrière du crâne et du cou, le long du plan x = 0
        if not seam and rs == {2} and a[1] < -0.03 and abs(a[0]) < 1e-4 and abs(b[0]) < 1e-4:
            seam = True
        e.seam = seam
    bm.to_mesh(me)
    bm.free()
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = body
    for o in bpy.context.view_layer.objects:
        o.select_set(o == body)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="CONFORMAL", margin=0.004)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    # agrandit les îles du visage et des oreilles
    # échelle par île (îles délimitées par les coutures)
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.active
    bm.faces.ensure_lookup_table()
    seen = set()
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        stack = [f0]
        isl = []
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            isl.append(f)
            for e in f.edges:
                if e.seam:
                    continue
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        r = np.bincount([freg[f.index] for f in isl]).argmax()
        k = {1: 1.0, 3: 0.30, 2: 1.0, 4: 1.6}[r]
        pts = np.array([l[uvl].uv[:] for f in isl for l in f.loops])
        c = pts.mean(0)
        for f in isl:
            for l in f.loops:
                l[uvl].uv = tuple(c + (np.array(l[uvl].uv[:]) - c) * k)
        for f in isl:
            f.material_index = 1 if r in FACE_REGIONS else 0
    bm.to_mesh(me)
    bm.free()
    for slot in (0, 1):
        # seules les faces de l'emplacement restent visibles pendant l'empaquetage
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.reveal()
        bpy.ops.mesh.select_all(action="DESELECT")
        body.active_material_index = slot
        bpy.ops.object.material_slot_select()
        bpy.ops.mesh.hide(unselected=True)
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.004 if slot else 0.006)
        bpy.ops.mesh.reveal()
        bpy.ops.object.mode_set(mode="OBJECT")
    return freg


def smart_unwrap(obj, margin=0.01):
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


# --- Matériaux ---------------------------------------------------------------------------
def gltf_output_group():
    """Groupe « glTF Material Output » reconnu par l'exporteur (entrée Occlusion)."""
    g = bpy.data.node_groups.get("glTF Material Output")
    if g:
        return g
    g = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    g.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    g.interface.new_socket("Thickness", in_out="INPUT", socket_type="NodeSocketFloat")
    return g


def new_material(name):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True
    return m, m.node_tree, m.node_tree.nodes["Principled BSDF"]


def tex(nt, img, colorspace="sRGB", x=-600, y=0):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = img
    img.colorspace_settings.name = colorspace
    n.location = (x, y)
    return n


def skin_material(albedo, normal, orm, name="Skin"):
    m, nt, b = new_material(name)
    tc = tex(nt, albedo, "sRGB", y=300)
    nt.links.new(tc.outputs["Color"], b.inputs["Base Color"])
    to = tex(nt, orm, "Non-Color", y=0)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-300, 0)
    nt.links.new(to.outputs["Color"], sep.inputs[0])
    nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], b.inputs["Metallic"])
    tn = tex(nt, normal, "Non-Color", y=-300)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.location = (-300, -300)
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    grp = nt.nodes.new("ShaderNodeGroup")
    grp.node_tree = gltf_output_group()
    grp.location = (200, -400)
    nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
    # rendu Blender : diffusion sous-cutanée (non exportée en glTF)
    b.inputs["Subsurface Weight"].default_value = 0.22
    b.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.18)
    b.inputs["Subsurface Scale"].default_value = 0.004
    b.inputs["Specular IOR Level"].default_value = 0.5
    b.inputs["IOR"].default_value = 1.4
    return m


def simple_material(name, color, rough=0.5, metal=0.0, alpha=None, ior=None, image=None, normal=None):
    m, nt, b = new_material(name)
    if image is not None:
        t = tex(nt, image, "sRGB", y=200)
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = (*color, 1)
    if normal is not None:
        tn = tex(nt, normal, "Non-Color", y=-300)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if alpha is not None:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
        m.use_backface_culling = False
    if ior is not None:
        b.inputs["IOR"].default_value = ior
    return m


def alpha_card_material(name, atlas, rough=0.55):
    """Cartes (cheveux, sourcils, cils) : couleur + alpha de l'atlas, découpe alpha (MASK)."""
    m, nt, b = new_material(name)
    t = tex(nt, atlas, "sRGB", y=100)
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    rnd = nt.nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    rnd.location = (-250, -150)
    nt.links.new(t.outputs["Alpha"], rnd.inputs[0])
    nt.links.new(rnd.outputs[0], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.22
    m.surface_render_method = "DITHERED"
    m.use_backface_culling = False
    return m


def set_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
