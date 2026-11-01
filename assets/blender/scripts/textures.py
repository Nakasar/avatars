"""Textures cuites (2048 px) : la position et la normale de chaque texel sont cuites avec
Cycles, puis les cartes sont peintes en numpy à partir de masques anatomiques.

glTF n'exporte pas les nœuds procéduraux : tout finit en images (couleur, normal map,
occlusion/roughness/metalness).
"""
import numpy as np
import bpy

import head_shape as hs
import hair
import noise
import sdf
import topo
import build_head as bh

BASE = bh.BASE


# --- Cuisson Cycles ------------------------------------------------------------------------
def _temp_material(kind):
    m = bpy.data.materials.new(f"__bake_{kind}")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    if kind in ("POS", "NRM"):
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        nt.links.new(geo.outputs["Position" if kind == "POS" else "Normal"], em.inputs["Color"])
    else:  # attribut de sommet nommé
        at = nt.nodes.new("ShaderNodeAttribute")
        at.attribute_name = kind
        nt.links.new(at.outputs["Fac"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def _with_image(obj, img, material=None):
    """Associe une image active (cible de cuisson) à tous les matériaux de l'objet."""
    mats = [s.material for s in obj.material_slots]
    if material is not None:
        saved = mats
        for s in obj.material_slots:
            s.material = material
        mats = [material]
    else:
        saved = None
    for m in set(mats):
        nt = m.node_tree
        node = nt.nodes.get("__bake_target") or nt.nodes.new("ShaderNodeTexImage")
        node.name = "__bake_target"
        node.image = img
        nt.nodes.active = node
    return saved


def _cleanup(obj, saved):
    for s in obj.material_slots:
        if s.material and s.material.node_tree.nodes.get("__bake_target"):
            s.material.node_tree.nodes.remove(s.material.node_tree.nodes["__bake_target"])
    if saved is not None:
        for s, m in zip(obj.material_slots, saved):
            s.material = m


def select_only(*objs, active=None):
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        if o is None:
            raise ValueError(f"objet manquant dans la sélection : {objs}")
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def bake_attribute(obj, size, kind):
    """Cuit la position (POS) ou la normale (NRM) monde de chaque texel. Retourne
    (valeurs H×W×3, masque des texels couverts)."""
    img = bpy.data.images.new(f"__{kind}", size, size, float_buffer=True, alpha=True)
    img.pixels.foreach_set(np.full(size * size * 4, -10.0, np.float32))
    mat = _temp_material(kind)
    saved = _with_image(obj, img, mat)
    scene = bpy.context.scene
    scene.cycles.samples = 1
    scene.render.bake.margin = 0
    scene.render.bake.use_clear = False
    scene.render.bake.use_selected_to_active = False
    select_only(obj)
    bpy.ops.object.bake(type="EMIT", margin=0, use_clear=False)
    a = np.array(img.pixels[:], np.float32).reshape(size, size, 4)
    _cleanup(obj, saved)
    bpy.data.images.remove(img)
    bpy.data.materials.remove(mat)
    mask = a[..., 0] > -9.0
    return a[..., :3].astype(np.float64), mask


def bake_ao(obj, size, samples=128):
    img = bpy.data.images.new("__AO", size, size, float_buffer=True)
    saved = _with_image(obj, img)
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.render.bake.margin = 8
    scene.render.bake.use_selected_to_active = False
    select_only(obj)
    bpy.ops.object.bake(type="AO", margin=8)
    a = np.array(img.pixels[:], np.float32).reshape(size, size, 4)[..., 0]
    _cleanup(obj, saved)
    bpy.data.images.remove(img)
    return a.astype(np.float64)


def bake_normals_from(high, low, size, extrusion=0.0015, distance=0.004):
    img = bpy.data.images.new("__NRM_hi", size, size, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    saved = _with_image(low, img)
    scene = bpy.context.scene
    scene.cycles.samples = 1
    bk = scene.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = extrusion
    bk.max_ray_distance = distance
    bk.margin = 0
    bk.normal_space = "TANGENT"
    select_only(high, low, active=low)
    bpy.ops.object.bake(type="NORMAL", margin=0, use_selected_to_active=True,
                        cage_extrusion=extrusion, max_ray_distance=distance)
    a = np.array(img.pixels[:], np.float32).reshape(size, size, 4)[..., :3]
    _cleanup(low, saved)
    bpy.data.images.remove(img)
    bk.use_selected_to_active = False
    return a.astype(np.float64) * 2 - 1


# --- Outils image -----------------------------------------------------------------------
def dilate(img, mask, iters=24):
    """Étend les couleurs des texels couverts vers leurs voisins (marges anti-coutures)."""
    img = img.copy()
    m = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(img)
        cnt = np.zeros(m.shape)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            mm = np.roll(np.roll(m, dy, 0), dx, 1)
            ii = np.roll(np.roll(img, dy, 0), dx, 1)
            acc += ii * mm[..., None] if img.ndim == 3 else ii * mm
            cnt += mm
        grow = (~m) & (cnt > 0)
        if not grow.any():
            break
        val = acc / np.maximum(cnt, 1)[..., None] if img.ndim == 3 else acc / np.maximum(cnt, 1)
        img[grow] = val[grow]
        m = m | grow
    # le reste : couleur moyenne
    if (~m).any():
        img[~m] = img[mask].mean(0)
    return img


def save_image(name, arr, path, srgb=True, alpha=None):
    """Enregistre un tableau H×W×3 (linéaire si srgb=True : converti) en PNG."""
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    if srgb:  # les pixels d'une image 8 bits sont stockés dans son espace colorimétrique
        a = np.clip(arr, 0, 1)
        arr = np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)
    rgba[..., :3] = arr
    if alpha is not None:
        rgba[..., 3] = alpha
    img = bpy.data.images.get(name) or bpy.data.images.new(name, w, h, alpha=alpha is not None)
    if img.size[0] != w:
        img.scale(w, h)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def gauss(p, c, s):
    q = (p - np.asarray(c)) / np.asarray(s)
    return np.exp(-0.5 * np.sum(q * q, -1))


def sym(p):
    q = p.copy()
    q[..., 0] = np.abs(q[..., 0])
    return q


# --- Masques anatomiques ----------------------------------------------------------------
def lip_masks(p):
    """Vermillon des lèvres (0–1) : bord supérieur en arc de Cupidon, bord inférieur arrondi."""
    x = np.abs(p[..., 0])
    z = p[..., 2]
    w = hs.MOUTH_W * 1.02
    u = np.clip(x / w, 0, 1)
    zs = hs.MOUTH_Z + 0.0010 * (1 - u * u) - 0.0016 * u ** 4
    top = zs + 0.0078 * (1 - u ** 2.2) ** 0.75 + 0.0011 * np.exp(-((x - 0.0058) / 0.0035) ** 2) \
        - 0.0010 * np.exp(-(x / 0.0025) ** 2)
    bot = zs - 0.0098 * (1 - u ** 2.0) ** 0.85
    soft = 0.0007
    up = sdf.smoothstep(-soft, soft, top - z) * sdf.smoothstep(-soft, soft, z - zs + 0.0004)
    lo = sdf.smoothstep(-soft, soft, z - bot) * sdf.smoothstep(-soft, soft, zs + 0.0004 - z)
    front = sdf.smoothstep(0.070, 0.080, p[..., 1])
    inside = (x < w).astype(float)
    return np.clip(up + lo, 0, 1) * front * inside


BEARD_X = [0.0, 0.012, 0.022, 0.035, 0.050, 0.066, 0.080]
BEARD_Z = [-0.0255, -0.0265, -0.0300, -0.0225, -0.0090, 0.0040, 0.0060]


def beard_mask(p):
    x = np.abs(p[..., 0])
    z = p[..., 2]
    top = sdf.pchip(BEARD_X, BEARD_Z, x)
    m = sdf.smoothstep(0.0, 0.004, top - z)
    m *= sdf.smoothstep(-0.020, -0.004, p[..., 1])          # devant les oreilles
    m *= 1 - sdf.smoothstep(-0.150, -0.120, -z) * 0          # (cou rasé plus bas)
    neck_fade = sdf.smoothstep(-0.150, -0.118, z)
    m *= neck_fade
    m *= 1 - lip_masks(p)
    return np.clip(m, 0, 1)


def eye_interior(p):
    out = 0.0
    for s in (-1, 1):
        c = hs.EYE_C * np.array([s, 1, 1])
        d = np.linalg.norm(p - c, axis=-1)
        out = np.maximum(out, 1 - sdf.smoothstep(hs.EYE_R + 0.0006, hs.EYE_R + 0.0013, d))
    return out


# --- Peau --------------------------------------------------------------------------------
SKIN = np.array([0.56, 0.30, 0.205])
RED = np.array([0.56, 0.14, 0.11])
LIP = np.array([0.46, 0.15, 0.135])
STUBBLE = np.array([0.20, 0.17, 0.165])
SCALP = hair.HAIR_COLOR * 1.15


def skin_maps(Pw, Nw, mask, ao, size, interior):
    """Peint couleur, roughness et hauteur de pores pour la peau.
    Pw / Nw : positions et normales monde (Blender) des texels."""
    P = topo.from_blender(Pw, BASE)
    N = np.stack([Nw[..., 0], -Nw[..., 1], Nw[..., 2]], -1)
    valid = mask
    p = P[valid]
    n = N[valid]
    sp = sym(p)

    lowf = noise.fbm3(p, 28.0, 3, seed=1)
    midf = noise.fbm3(p, 140.0, 3, seed=2)
    col = SKIN[None] * (1 + 0.07 * lowf[:, None] + 0.035 * midf[:, None])
    # légère dominante jaune sur le front, plus rosée sur le bas du visage
    col *= 1 + 0.03 * np.clip((p[:, 2] - 0.04) / 0.05, 0, 1)[:, None] * np.array([0.3, 0.2, -0.6])

    red = (0.55 * gauss(sp, (0.046, 0.074, -0.004), (0.016, 0.02, 0.016))
           + 0.70 * gauss(sp, (0.0, 0.112, -0.013), (0.011, 0.012, 0.010))
           + 0.55 * gauss(sp, (0.014, 0.098, -0.018), (0.008, 0.010, 0.008))
           + 0.55 * gauss(sp, (0.078, -0.010, 0.006), (0.020, 0.030, 0.035))
           + 0.30 * gauss(sp, (0.0, 0.095, -0.084), (0.014, 0.02, 0.012))
           + 0.25 * gauss(sp, (0.032, 0.080, 0.028), (0.016, 0.02, 0.006))
           + 0.15 * gauss(sp, (0.0, 0.095, 0.060), (0.03, 0.04, 0.02)))
    red *= 1 + 0.4 * noise.fbm3(p, 90.0, 3, seed=3)
    col = col * (1 - 0.40 * red[:, None]) + RED[None] * 0.40 * red[:, None]

    # cernes discrètes
    dark = gauss(sp, (0.031, 0.079, 0.008), (0.012, 0.02, 0.0045))
    col *= (1 - 0.16 * dark)[:, None] * np.array([1.0, 0.97, 1.02])

    # barbe de quelques jours
    beard = beard_mask(p)
    folli = noise.fbm3(p, 2200.0, 2, seed=4)
    stub = beard * np.clip(0.55 + 0.9 * folli, 0, 1)
    col = col * (1 - 0.55 * stub[:, None]) + STUBBLE[None] * 0.55 * stub[:, None]

    # cuir chevelu (cheveux ras sous les mèches) et sourcils
    hm = sdf.smoothstep(-0.003, 0.006, hair.hair_mask(p))
    hdots = np.clip(0.6 + 0.8 * noise.fbm3(p, 2600.0, 2, seed=5), 0, 1)
    scalp = hm * (0.55 + 0.45 * hdots) * sdf.smoothstep(0.0, 0.004, hair.hair_mask(p) + 0.002)
    col = col * (1 - 0.92 * scalp[:, None]) + SCALP[None] * 0.92 * scalp[:, None]
    brow = hair.brow_mask(p) * np.clip(0.5 + noise.fbm3(p, 1800.0, 2, seed=6), 0, 1)
    col = col * (1 - 0.70 * brow[:, None]) + SCALP[None] * 0.5 * 0.70 * brow[:, None]

    # lèvres
    lips = lip_masks(p)
    lipc = LIP[None] * (1 + 0.08 * midf[:, None])
    col = col * (1 - lips[:, None]) + lipc * lips[:, None]

    # intérieurs : conjonctive, bouche, narines, conduit auditif
    inner = interior[valid]
    eyei = eye_interior(p) * np.clip(inner * 1.5, 0, 1)
    col = col * (1 - eyei[:, None]) + np.array([0.62, 0.30, 0.27])[None] * eyei[:, None]
    fval = hs.field(p)
    near_mouth = (np.abs(p[:, 0]) < 0.05) & (np.abs(p[:, 2] - hs.MOUTH_Z) < 0.04) & (p[:, 1] > 0.0)
    depth = np.clip((0.096 - 22 * p[:, 0] ** 2 - p[:, 1]) / 0.02, 0, 1)
    mouth_in = near_mouth & (inner > 0.5) & (eyei < 0.5)
    mcol = np.array([0.42, 0.13, 0.12])[None] * (1 - depth[:, None]) ** 1.5 + np.array([0.03, 0.006, 0.006])[None] * depth[:, None]
    col[mouth_in] = mcol[mouth_in]
    nost = np.maximum(gauss(sp, (0.0066, 0.1025, -0.0246), (0.0030, 0.0042, 0.0018)) * (n[:, 2] < -0.2), 0)
    col *= (1 - 0.85 * np.clip(nost * 1.6, 0, 1))[:, None]
    canal = (inner > 0.5) * (np.abs(p[:, 0]) > 0.05)
    col *= (1 - 0.8 * canal)[:, None]

    # occlusion ambiante cuite (légère, le reste passe par la carte d'occlusion glTF)
    a = ao[valid]
    col *= (0.55 + 0.45 * a ** 0.6)[:, None]

    # roughness
    rough = 0.57 + 0.05 * lowf
    tz = (gauss(sp, (0.0, 0.10, 0.065), (0.022, 0.05, 0.02)) * 0.10
          + gauss(sp, (0.0, 0.11, -0.005), (0.012, 0.03, 0.022)) * 0.14
          + gauss(sp, (0.0, 0.095, -0.085), (0.014, 0.02, 0.012)) * 0.06)
    rough -= tz
    rough = rough * (1 - lips) + 0.33 * lips
    rough = rough * (1 - scalp) + 0.62 * scalp
    rough = np.where(mouth_in, 0.22, rough)
    rough = rough * (1 - eyei) + 0.16 * eyei
    rough += 0.03 * noise.fbm3(p, 600.0, 2, seed=7)

    # assemblage dans l'image
    albedo = np.zeros((size, size, 3))
    albedo[valid] = np.clip(col, 0, 1)
    R = np.zeros((size, size))
    R[valid] = np.clip(rough, 0.12, 0.9)
    pore_w = np.zeros((size, size))
    pw = (0.6 + 0.6 * gauss(sp, (0.0, 0.11, -0.005), (0.02, 0.05, 0.02))
          + 0.4 * gauss(sp, (0.04, 0.075, -0.01), (0.02, 0.03, 0.02))) * (1 - lips) * (1 - scalp * 0.7)
    pw = np.where(mouth_in | (eyei > 0.5), 0.0, pw)
    pore_w[valid] = pw
    lipm = np.zeros((size, size))
    lipm[valid] = lips
    return albedo, R, pore_w, lipm, P


def wrinkle_displacement(p):
    """Rides et plis (m, le long de la normale) appliqués au maillage haute résolution."""
    sp = sym(p)
    x, f, z = sp[:, 0], sp[:, 1], sp[:, 2]
    d = np.zeros(len(p))
    # rides du front
    fore = sdf.smoothstep(0.075, 0.085, f) * (1 - sdf.smoothstep(0.035, 0.050, x))
    for zi, a in ((0.058, 1.0), (0.067, 0.9), (0.076, 0.7)):
        zz = zi + 0.002 * np.cos(x / 0.03 * np.pi)
        d -= a * 0.00010 * np.exp(-((z - zz) / 0.0011) ** 2) * fore
    # sillons naso-géniens : du sillon alaire vers l'extérieur de la commissure
    a0 = np.array([0.0215, -0.016])
    a1 = np.array([0.0345, -0.054])
    seg = a1 - a0
    t = np.clip(((x - a0[0]) * seg[0] + (z - a0[1]) * seg[1]) / np.dot(seg, seg), 0, 1)
    dist = np.hypot(x - (a0[0] + seg[0] * t), z - (a0[1] + seg[1] * t))
    fold = np.exp(-(dist / 0.0016) ** 2) * (1 - 0.6 * t) * sdf.smoothstep(0.07, 0.08, f)
    d -= 0.00045 * fold
    # bourrelet de joue au-dessus du sillon
    side = (x - (a0[0] + seg[0] * t)) > 0
    d += 0.00020 * np.exp(-((dist - 0.0028) / 0.0022) ** 2) * side * (1 - t) * sdf.smoothstep(0.07, 0.08, f)
    # pli palpébral supérieur
    c = hs.EYE_C
    q = sp - c
    r = np.linalg.norm(q, axis=1)
    ang = np.arctan2(q[:, 2], np.hypot(q[:, 0] * 0.7, q[:, 1]))
    crease = np.exp(-((ang - 0.86) / 0.07) ** 2) * (r < 0.0175) * sdf.smoothstep(0.072, 0.078, f)
    d -= 0.00035 * crease
    # vallée des larmes sous l'œil
    tt = np.exp(-(((z - 0.0085) + 0.25 * (x - 0.022)) / 0.0018) ** 2) * np.exp(-((x - 0.028) / 0.011) ** 2)
    d -= 0.00018 * tt * sdf.smoothstep(0.075, 0.082, f)
    # pattes d'oie
    for k in range(3):
        zz = 0.014 + 0.006 * k + 0.25 * (x - 0.050)
        d -= 0.00006 * np.exp(-((z - zz) / 0.0007) ** 2) * np.exp(-((x - 0.054) / 0.0045) ** 2)
    # stries verticales des lèvres
    lm = lip_masks(p)
    d += 0.000035 * np.sin(p[:, 0] / 0.0011 * np.pi + 3 * noise.value3(p, 400.0)) * lm
    # pli mento-labial
    d -= 0.00020 * np.exp(-((z + 0.0665) / 0.0025) ** 2) * np.exp(-(x / 0.016) ** 2) * sdf.smoothstep(0.085, 0.092, f)
    # léger grain moyen (relief de la peau)
    d += 0.00003 * noise.fbm3(p, 900.0, 3, seed=11)
    return d


def height_to_normal(H, strength):
    gy, gx = np.gradient(H)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(H)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def combine_normals(base, detail):
    """Fusion UDN de deux normal maps en espace tangent."""
    n = np.stack([base[..., 0] + detail[..., 0], base[..., 1] + detail[..., 1], base[..., 2]], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def pore_normal(size, weight, lipm):
    H = 0.6 * noise.pores2((size, size), 0.020, 0.7, seed=21) + 0.35 * noise.fbm2((size, size), 3.0, 2, seed=22)
    H *= weight
    # stries des lèvres en espace texture (fines)
    H += 0.25 * lipm * noise.fbm2((size, size), 1.5, 1, seed=23)
    return height_to_normal(H, 0.9)


# --- Yeux ------------------------------------------------------------------------------
def eye_texture(size=1024, iris=(0.085, 0.050, 0.028)):
    yy, xx = np.mgrid[0:size, 0:size]
    u = (xx + 0.5) / size - 0.5
    v = (yy + 0.5) / size - 0.5
    r = np.hypot(u, v) * 2          # 0 au centre (pupille), 1 au pôle arrière
    alpha = r * np.pi               # angle depuis l'axe optique
    th = np.arctan2(v, u)
    al_l = np.arcsin(0.0058 / hs.EYE_R)
    al_p = np.radians(8.5)
    t_iris = np.clip((alpha - al_p) / (al_l - al_p), 0, 1)
    rng = np.random.default_rng(3)
    # fibres radiales de l'iris
    fib = np.zeros_like(r)
    for k, (freq, amp) in enumerate(((48, 0.35), (97, 0.25), (190, 0.15))):
        ph = rng.uniform(0, 2 * np.pi, 8)
        fib += amp * np.sin(th * freq + 3 * np.sin(th * 5 + ph[0]) + t_iris * ph[1] * 2)
    fib += 0.4 * noise.fbm2((size, size), 6.0, 3, seed=31)
    base = np.array(iris)
    light = base * 1.9 + np.array([0.05, 0.05, 0.02])
    collar = np.exp(-((t_iris - 0.32) / 0.12) ** 2)
    ic = base[None, None] * (1 + 0.45 * fib[..., None]) + (light - base)[None, None] * collar[..., None] * 0.6
    ic *= (1 - 0.55 * sdf.smoothstep(0.80, 1.0, t_iris))[..., None]       # anneau limbique
    ic *= (1 - 0.35 * sdf.smoothstep(0.0, 0.12, 0.12 - t_iris))[..., None]
    sclera = np.array([0.64, 0.59, 0.54])[None, None] * (1 - 0.06 * noise.fbm2((size, size), 30, 3, seed=32))[..., None]
    # vaisseaux discrets vers l'arrière
    ves = np.clip(noise.fbm2((size, size), 9, 4, seed=33), 0, 1)
    vmask = np.exp(-((np.abs(noise.fbm2((size, size), 14, 3, seed=34))) / 0.03) ** 2) * sdf.smoothstep(0.75, 1.2, alpha)
    sclera = sclera * (1 - 0.35 * vmask[..., None]) + np.array([0.55, 0.12, 0.10])[None, None] * 0.35 * vmask[..., None]
    sclera *= (1 - 0.12 * sdf.smoothstep(0.6, 1.3, alpha))[..., None]
    col = np.where((alpha < al_l + 0.01)[..., None], ic, sclera)
    # transition limbe → sclère douce
    lim = sdf.smoothstep(al_l - 0.015, al_l + 0.03, alpha)
    col = ic * (1 - lim[..., None]) + sclera * lim[..., None]
    col = np.where((alpha < al_l)[..., None], ic, col)
    pupil = 1 - sdf.smoothstep(al_p - 0.012, al_p + 0.004, alpha)
    col = col * (1 - pupil[..., None]) + 0.004 * pupil[..., None]
    return np.clip(col, 0, 1)


# --- Tissu -----------------------------------------------------------------------------
def shirt_maps(Pw, mask, size, color=(0.035, 0.045, 0.075)):
    P = topo.from_blender(Pw, BASE)
    p = P[mask]
    c = np.array(color)
    heather = noise.fbm3(p, 900.0, 2, seed=41)
    col = c[None] * (1 + 0.18 * heather[:, None] + 0.08 * noise.fbm3(p, 60, 2, seed=42)[:, None])
    albedo = np.zeros((size, size, 3))
    albedo[mask] = col
    # plis doux (grande échelle) + maille (texture)
    H3 = np.zeros((size, size))
    H3[mask] = 1.0 * noise.fbm3(p * np.array([1.0, 1.0, 0.35]), 22.0, 3, seed=43)
    knit = noise.value2((size, size), 1.2, seed=44) * 0.5 + np.sin(np.arange(size)[None, :] * 2.2) * 0.25
    Hn = height_to_normal(H3 * 6.0, 1.0)
    Kn = height_to_normal(knit, 0.6)
    nrm = Kn
    return albedo, nrm
