"""Construction complète de l'avatar (à lancer avec Blender en arrière-plan) :

    blender --background --factory-startup --python build_avatar.py -- <dossier_sortie> [options]

Étapes : peau (tête + cou) → yeux, dents, langue, oreilles → sourcils, cils, cheveux →
t-shirt → UV et textures cuites → squelette et poids → shape keys ARKit + visèmes →
export glTF (.glb) → rendus de contrôle.
"""
import importlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402

import sdf, topo, head_shape, build_head, build_body, parts, hair, torso, studio  # noqa: E402,E401
import noise, textures, materials, roles, shapes, rig  # noqa: E402,E401

MODULES = [sdf, topo, head_shape, build_head, build_body, parts, hair, torso, studio, noise, textures,
           materials, roles, shapes, rig]
for _m in MODULES:
    importlib.reload(_m)

BASE = build_head.BASE


def to_bl(p):
    return topo.to_blender(np.asarray(p, float), BASE)


def collection():
    col = bpy.data.collections.get("Avatar")
    if not col:
        col = bpy.data.collections.new("Avatar")
        bpy.context.scene.collection.children.link(col)
    return col


def make_object(name, verts, faces, uvs=None, smooth=True, material=None, recalc=True):
    """Crée un objet maillage à partir de sommets anatomiques."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_bl(verts).tolist(), [], [list(map(int, f)) for f in faces])
    me.validate()
    if uvs is not None:
        uvl = me.uv_layers.new(name="UVMap")
        flat = [uv for f in uvs for uv in f]
        uvl.data.foreach_set("uv", np.array(flat, np.float32).ravel())
    bm = bmesh.new()
    bm.from_mesh(me)
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        orient_components(bm)
    else:
        orient_cards(bm)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    collection().objects.link(ob)
    if material:
        me.materials.append(material)
    return ob


def orient_components(bm):
    """Normales vers l'extérieur, composante connexe par composante connexe."""
    seen = set()
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        comp, stack = [], [f0]
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            comp.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        cen = sum((f.calc_center_median() for f in comp), comp[0].normal * 0) / len(comp)
        score = sum((f.calc_center_median() - cen).dot(f.normal) * f.calc_area() for f in comp)
        if score < 0:
            for f in comp:
                f.normal_flip()
    bm.normal_update()


def orient_cards(bm):
    """Cartes (poils) : normale opposée au centre de la tête."""
    from mathutils import Vector
    head = Vector((0.0, 0.0, BASE[2] + 0.03))
    bm.normal_update()
    for f in bm.faces:
        if (f.calc_center_median() - head).dot(f.normal) < 0:
            f.normal_flip()
    bm.normal_update()


def clay(name, color, rough=0.5):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    return m


def build_skin():
    bm, loops, P = build_head.build()
    groups = build_body.finish(bm, loops, P)
    groups["margins"] = {k: np.array([v.co[:] for v in loops[k]])
                         for k in ("eye1_up", "eye1_lo", "eye-1_up", "eye-1_lo")}
    groups["roles"] = roles.compute(bm, loops, groups)
    for v in bm.verts:
        v.co = to_bl(np.array(v.co[:])).tolist()
    # le passage anatomique → Blender est une réflexion (y = -f) : on rétablit l'orientation
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    # attribut « interior » : faces internes (paupières, bouche) pour la peinture des textures
    inner = set()
    for key in ("lid_inner1", "lid_inner-1", "fornix1", "fornix-1", "mouth_r1", "mouth_r2", "mouth_r3", "mouth_r4"):
        inner |= set(groups[key])
    bm.verts.index_update()
    flags = [1.0 if v in inner else 0.0 for v in bm.verts]
    me = bpy.data.meshes.new("Body")
    bm.to_mesh(me)
    at = me.attributes.new("interior", "FLOAT", "POINT")
    at.data.foreach_set("value", flags)
    for name, w in groups["roles"].items():
        me.attributes.new(name, "FLOAT", "POINT").data.foreach_set("value", w.tolist())
    me.shade_smooth()
    ob = bpy.data.objects.new("Body", me)
    collection().objects.link(ob)
    return ob, bm, loops, groups


def build_parts():
    objs = {}
    for s, tag in ((1, "L"), (-1, "R")):
        v, f, uv = parts.eyeball(s)
        objs[f"Eyeball_{tag}"] = make_object(f"Eyeball_{tag}", v, f, uv, material=clay("EyeTmp", (0.85, 0.85, 0.85)))
        v, f, uv = parts.cornea(s)
        objs[f"Cornea_{tag}"] = make_object(f"Cornea_{tag}", v, f, uv, material=clay("CorneaTmp", (0.9, 0.9, 1.0), 0.05))
        v, f, uv = parts.ear(s)
        objs[f"Ear_{tag}"] = make_object(f"Ear_{tag}", v, f, uv, material=clay("Clay", (0.62, 0.45, 0.38)))
    for name, arch, spec in (("TeethUpper", parts.UPPER, parts.UPPER_TEETH),
                             ("TeethLower", parts.LOWER, parts.LOWER_TEETH)):
        v, f, _ = parts.teeth(arch, spec)
        objs[name] = make_object(name, v, f, material=clay("TeethTmp", (0.85, 0.82, 0.74), 0.3))
        v, f, _ = parts.gums(arch)
        objs[name.replace("Teeth", "Gums")] = make_object(name.replace("Teeth", "Gums"), v, f,
                                                          material=clay("GumTmp", (0.7, 0.3, 0.3), 0.4))
    v, f = torso.build(18)
    objs["Shirt"] = make_object("Shirt", v, f, material=clay("ShirtTmp", (0.08, 0.10, 0.14), 0.8))
    v, f, _ = parts.tongue()
    objs["Tongue"] = make_object("Tongue", v, f, material=clay("TongueTmp", (0.6, 0.25, 0.25), 0.4))
    return objs


def build_hair(groups):
    objs = {}
    mat = clay("HairTmp", tuple(hair.HAIR_COLOR * 3), 0.6)
    v, f, uv = hair.hair_cards()
    objs["Hair"] = make_object("Hair", v, f, uv, material=mat, recalc=False)
    v, f, uv = hair.brow_cards()
    objs["Eyebrows"] = make_object("Eyebrows", v, f, uv, material=mat, recalc=False)
    vs, fs, uvs = [], [], []
    for s, tag in ((1, "1"), (-1, "-1")):
        for up in (True, False):
            m = groups["margins"][f"eye{tag}_{'up' if up else 'lo'}"]
            v, f, uv = hair.lash_strip(m, s, up)
            fs += [[i + len(vs) for i in ff] for ff in f]
            vs += v.tolist()
            uvs += uv
    objs["Eyelashes"] = make_object("Eyelashes", np.array(vs), fs, uvs, material=clay("LashTmp", (0.01, 0.01, 0.01)), recalc=False)
    return objs


TEX_DIR = os.path.normpath(os.path.join(HERE, "..", "textures"))
TEX = 2048


def save_tex(name, arr, srgb=True, alpha=None):
    os.makedirs(TEX_DIR, exist_ok=True)
    path = os.path.join(TEX_DIR, name + ".png")
    img = textures.save_image(name, arr, path, srgb=srgb, alpha=alpha)
    return img


def join_into(target, others):
    textures.select_only(target, *others, active=target)
    bpy.ops.object.join()
    return target


def high_res_copy(body):
    """Copie subdivisée de la peau, recollée au champ anatomique et ridée."""
    hi = body.copy()
    hi.data = body.data.copy()
    hi.name = "Body_hi"
    collection().objects.link(hi)
    # sans les faces internes (bouche, paupières) : la subdivision les ferait ressortir
    bm = bmesh.new()
    bm.from_mesh(hi.data)
    inner = bm.verts.layers.float.get("interior")
    kill = [f for f in bm.faces if any(v[inner] > 0.5 for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(hi.data)
    bm.free()
    mod = hi.modifiers.new("sub", "SUBSURF")
    mod.levels = 2
    mod.render_levels = 2
    textures.select_only(hi)
    bpy.ops.object.modifier_apply(modifier="sub")
    me = hi.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    P = topo.from_blender(co.reshape(-1, 3), BASE)
    fv = head_shape.field(P)
    on = np.abs(fv) < 0.0010
    q = P[on]
    q = build_head.snap(q, 3)
    g = build_head.gradient(q)
    nrm = g / np.linalg.norm(g, axis=1, keepdims=True)
    q = q + nrm * textures.wrinkle_displacement(q)[:, None]
    P[on] = q
    me.vertices.foreach_set("co", to_bl(P).ravel())
    me.update()
    return hi


def texture_stage(body, objs):
    t0 = time.time()
    materials.unwrap_body(body)
    Pw, mask = textures.bake_attribute(body, TEX, "POS")
    Nw, _ = textures.bake_attribute(body, TEX, "NRM")
    Iw, _ = textures.bake_attribute(body, TEX, "interior")
    print("  bake pos/nrm", time.time() - t0)
    ao = textures.bake_ao(body, TEX, samples=96)
    print("  bake ao", time.time() - t0)
    hi = high_res_copy(body)
    nrm_mid = textures.bake_normals_from(hi, body, TEX, extrusion=0.0015, distance=0.005)
    bpy.data.objects.remove(hi)
    print("  bake normals", time.time() - t0)
    albedo, rough, pore_w, lipm, _ = textures.skin_maps(Pw, Nw, mask, ao, TEX, Iw[..., 0])
    nrm_mid = np.where(mask[..., None], nrm_mid, np.array([0, 0, 1.0]))
    # normales aberrantes (faces très fines aux commissures) : ramenées vers la normale plate
    bad = np.clip((0.75 - nrm_mid[..., 2]) / 0.25, 0, 1)[..., None]
    nrm_mid = nrm_mid * (1 - bad) + np.array([0, 0, 1.0]) * bad
    nrm_mid /= np.linalg.norm(nrm_mid, axis=-1, keepdims=True)
    nrm = textures.combine_normals(nrm_mid, textures.pore_normal(TEX, pore_w, lipm))
    albedo = textures.dilate(albedo, mask)
    rough = textures.dilate(rough, mask)
    aod = textures.dilate(np.clip(ao, 0, 1), mask)
    nrm = textures.dilate(nrm, mask)
    print("  paint", time.time() - t0)
    i_alb = save_tex("skin_albedo", albedo)
    i_nrm = save_tex("skin_normal", nrm * 0.5 + 0.5, srgb=False)
    orm = np.stack([0.35 + 0.65 * aod, rough, np.zeros_like(rough)], -1)
    i_orm = save_tex("skin_orm", orm, srgb=False)
    materials.set_material(body, materials.skin_material(i_alb, i_nrm, i_orm))

    # yeux
    eye = textures.eye_texture(1024)
    i_eye = save_tex("eye_albedo", eye)
    m_eye = materials.simple_material("Eye", (1, 1, 1), rough=0.25, image=i_eye)
    m_cor = materials.simple_material("Cornea", (0.0, 0.0, 0.0), rough=0.02, alpha=0.10, ior=1.376)
    for tag in ("L", "R"):
        materials.set_material(objs[f"Eyeball_{tag}"], m_eye)
        materials.set_material(objs[f"Cornea_{tag}"], m_cor)
    # bouche
    materials.set_material(objs["TeethUpper"], materials.simple_material("Teeth", (0.80, 0.75, 0.64), 0.32))
    materials.set_material(objs["TeethLower"], bpy.data.materials["Teeth"])
    m_gum = materials.simple_material("Gums", (0.52, 0.17, 0.16), 0.38)
    materials.set_material(objs["GumsUpper"], m_gum)
    materials.set_material(objs["GumsLower"], m_gum)
    materials.set_material(objs["Tongue"], materials.simple_material("Tongue", (0.50, 0.18, 0.17), 0.42))
    # poils
    atlas = hair.strand_atlas(1024)
    i_hair = save_tex("hair_atlas", atlas[..., :3], alpha=atlas[..., 3])
    materials.set_material(objs["Hair"], materials.alpha_card_material("Hair", i_hair, 0.66))
    materials.set_material(objs["Eyebrows"], materials.alpha_card_material("Eyebrows", i_hair, 0.72))
    materials.set_material(objs["Eyelashes"], materials.alpha_card_material("Eyelashes", i_hair, 0.45))
    # t-shirt
    sh = objs["Shirt"]
    materials.smart_unwrap(sh)
    Ps, ms = textures.bake_attribute(sh, 1024, "POS")
    alb, nr = textures.shirt_maps(Ps, ms, 1024)
    alb = textures.dilate(alb, ms)
    i_sa = save_tex("shirt_albedo", alb)
    i_sn = save_tex("shirt_normal", nr * 0.5 + 0.5, srgb=False)
    materials.set_material(sh, materials.simple_material("Shirt", (1, 1, 1), 0.88, image=i_sa, normal=i_sn))
    print("TEXTURES", time.time() - t0)


def read_attr(obj, name):
    a = np.zeros(len(obj.data.vertices))
    if name in obj.data.attributes:
        obj.data.attributes[name].data.foreach_get("value", a)
    return a


def rig_stage(objs, body):
    arm = rig.build_armature(collection())
    rig.assign(body, arm, rig.skin_weights(body, read_attr(body, "jaw")))
    ones = lambda o: np.ones(len(o.data.vertices))
    for name in ("Eyeball_L", "Cornea_L"):
        rig.assign(objs[name], arm, {"LeftEye": ones(objs[name])})
    for name in ("Eyeball_R", "Cornea_R"):
        rig.assign(objs[name], arm, {"RightEye": ones(objs[name])})
    for name in ("TeethUpper", "GumsUpper", "Hair", "Eyebrows", "Eyelashes"):
        rig.assign(objs[name], arm, {"Head": ones(objs[name])})
    for name in ("TeethLower", "GumsLower", "Tongue"):
        rig.assign(objs[name], arm, {"Jaw": ones(objs[name])})
    rig.assign(objs["Shirt"], arm, rig.shirt_weights(objs["Shirt"]))
    return arm


def add_keys(obj, deltas):
    """deltas : liste (nom, déplacement anatomique N×3)."""
    co = np.zeros(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    rest = co.reshape(-1, 3)
    obj.shape_key_add(name="Basis", from_mix=False)
    for name, d in deltas:
        k = obj.shape_key_add(name=name, from_mix=False)
        db = np.stack([d[:, 0], -d[:, 1], d[:, 2]], 1)       # anatomique → Blender
        k.data.foreach_set("co", (rest + db).ravel())
    obj.data.shape_keys.use_relative = True


def shape_stage(objs, body, margins):
    from mathutils import kdtree
    t0 = time.time()
    P = rig.anat(body)
    names = ["jaw", "lip_upper", "lip_lower", "lid_up_L", "lid_lo_L", "lid_up_R", "lid_lo_R"]
    face = shapes.FaceRig(P, {n: read_attr(body, n) for n in names}, margins)
    targets = shapes.all_targets()
    body_d = [(n, face.combo(w)) for n, w in targets]
    add_keys(body, body_d)
    print("  shape keys peau", time.time() - t0)
    for name in ("TeethLower", "GumsLower"):
        Q = rig.anat(objs[name])
        add_keys(objs[name], [(n, shapes.rigid_delta(Q, w)) for n, w in targets])
    Q = rig.anat(objs["Tongue"])
    add_keys(objs["Tongue"], [(n, shapes.rigid_delta(Q, w, tongue=True)) for n, w in targets])
    # cils et sourcils : collés à la peau
    me = body.data
    nb = [[] for _ in range(len(me.vertices))]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    nb = [np.array(x, int) for x in nb]
    tree = kdtree.KDTree(len(P))
    skin_only = read_attr(body, "interior") < 0.5
    for i, p in enumerate(P):
        if skin_only[i]:
            tree.insert(p.tolist(), i)
    tree.balance()
    for name, rows in (("Eyelashes", 3), ("Eyebrows", 1)):
        Q = rig.anat(objs[name])
        roots = (np.arange(len(Q)) // rows) * rows
        idx = np.array([tree.find(Q[r].tolist())[1] for r in roots])
        add_keys(objs[name], [(n, shapes.transfer(P, d, nb, idx, Q)) for n, d in body_d])
    print("  shape keys", time.time() - t0)


EXPORT_OBJECTS = ["Body", "Eyeball_L", "Eyeball_R", "Cornea_L", "Cornea_R", "TeethUpper", "TeethLower",
                  "GumsUpper", "GumsLower", "Tongue", "Hair", "Eyebrows", "Eyelashes", "Shirt"]


def export_glb(path, arm):
    objs = [bpy.data.objects[n] for n in EXPORT_OBJECTS] + [arm]
    textures.select_only(*objs, active=arm)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=False,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_image_format="WEBP", export_image_quality=88,
        export_skins=True, export_morph=True, export_morph_normal=True, export_try_sparse_sk=True,
        export_animations=False, export_cameras=False, export_lights=False)


def set_expression(weights):
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob.data.shape_keys:
            for kb in ob.data.shape_keys.key_blocks[1:]:
                kb.value = weights.get(kb.name, 0.0)


def control_renders(out_dir, prefix=""):
    os.makedirs(out_dir, exist_ok=True)
    ims = bpy.context.scene.render.image_settings
    ims.file_format = "JPEG"
    ims.quality = 90
    tgt = (0, -0.03, 1.57)
    shots = []
    set_expression({})
    for yaw, lab in ((0, "face"), (35, "trois_quarts"), (90, "profil")):
        shots.append(studio.shoot(os.path.join(out_dir, f"{prefix}{lab}.jpg"), yaw, target=tgt, dist=0.78))
    close = (0, -0.08, 1.595)
    for lab, w in (("neutre", {}), ("jawOpen", {"jawOpen": 1.0}),
                   ("sourire", {"mouthSmileLeft": 1.0, "mouthSmileRight": 1.0, "cheekSquintLeft": 0.4, "cheekSquintRight": 0.4}),
                   ("clignement", {"eyeBlinkLeft": 1.0, "eyeBlinkRight": 1.0}),
                   ("viseme_aa", {"viseme_aa": 1.0}), ("viseme_O", {"viseme_O": 1.0}),
                   ("viseme_FF", {"viseme_FF": 1.0}), ("surpris", {"browInnerUp": 0.8, "browOuterUpLeft": 0.7, "browOuterUpRight": 0.7, "eyeWideLeft": 0.6, "eyeWideRight": 0.6, "jawOpen": 0.25})):
        set_expression(w)
        shots.append(studio.shoot(os.path.join(out_dir, f"{prefix}expr_{lab}.jpg"), 12, target=close, dist=0.45))
    set_expression({})
    return shots


REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
GLB_PATH = os.path.join(REPO, "public", "models", "human.glb")
BLEND_PATH = os.path.join(REPO, "assets", "blender", "human.blend")
RENDER_DIR = os.path.join(REPO, "assets", "blender", "renders")


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    final = "--export" in argv
    argv = [a for a in argv if not a.startswith("--")]
    out = argv[0] if argv else os.path.join(RENDER_DIR, "preview")
    t0 = time.time()
    studio.setup(samples=96 if final else 64, res=1000 if final else 800)
    body, bm, loops, groups = build_skin()
    body.data.materials.append(clay("Clay", (0.62, 0.45, 0.38)))
    objs = build_parts()
    objs.update(build_hair(groups))
    join_into(body, [objs.pop("Ear_L"), objs.pop("Ear_R")])
    print("BUILD", time.time() - t0)
    texture_stage(body, objs)
    arm = rig_stage(objs, body)
    shape_stage(objs, body, groups["margins"])
    print("RIG+SHAPES", time.time() - t0)
    if final:
        export_glb(GLB_PATH, arm)
        bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH, relative_remap=True)
        control_renders(RENDER_DIR)
        print("EXPORT", GLB_PATH, os.path.getsize(GLB_PATH))
    else:
        set_expression({})
        paths = [studio.shoot(f"{out}_{l}.png", y, target=(0, -0.03, 1.56), dist=0.85) for y, l in ((0, "f"), (35, "tq"), (90, "p"))]
        studio.montage(paths, out + "_montage.png")
        paths = [studio.shoot(f"{out}_c{y}.png", y, target=(0, -0.08, 1.60), dist=0.42) for y in (0, 30, 60)]
        studio.montage(paths, out + "_close.png")
        shots = []
        for lab, w in (("jaw", {"jawOpen": 1.0}), ("smile", {"mouthSmileLeft": 1.0, "mouthSmileRight": 1.0}),
                       ("blink", {"eyeBlinkLeft": 1.0, "eyeBlinkRight": 1.0}), ("O", {"viseme_O": 1.0})):
            set_expression(w)
            shots.append(studio.shoot(f"{out}_x_{lab}.png", 12, target=(0, -0.08, 1.595), dist=0.42))
        set_expression({})
        studio.montage(shots, out + "_expr.png")
        bpy.ops.wm.save_as_mainfile(filepath=out + ".blend")
    print("TOTAL", time.time() - t0)
