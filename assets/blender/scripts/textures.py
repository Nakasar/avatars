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


def select_only(*objs, active=None):
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        if o is None:
            raise ValueError(f"objet manquant dans la sélection : {objs}")
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def bake_slots(obj, sizes, bake_type, emit=None, samples=1, margin=0, clear=None,
               high=None, extrusion=0.0, distance=0.0, hide=()):
    """Cuit une image par emplacement de matériau (tailles `sizes`, dans l'ordre des
    emplacements). emit : None (matériaux d'origine), "POS", "NRM" ou nom d'attribut.
    Retourne la liste des tableaux H×W×4."""
    slots = list(obj.material_slots)
    saved = [s.material for s in slots]
    imgs, temps = [], []
    for slot, size in zip(slots, sizes):
        img = bpy.data.images.new(f"__bake_{len(imgs)}", size, size, float_buffer=True, alpha=True)
        img.colorspace_settings.name = "Non-Color"
        if clear is not None:
            img.pixels.foreach_set(np.full(size * size * 4, clear, np.float32))
        if emit:
            m = _temp_material(emit)
            slot.material = m
            temps.append(m)
        nt = slot.material.node_tree
        node = nt.nodes.new("ShaderNodeTexImage")
        node.name = "__bake_target"
        node.image = img
        nt.nodes.active = node
        imgs.append(img)
    hidden = [(o, o.hide_render) for o in hide]
    for o, _ in hidden:
        o.hide_render = True
    scene = bpy.context.scene
    scene.cycles.samples = samples
    bk = scene.render.bake
    bk.margin = margin
    bk.use_clear = clear is None
    bk.use_selected_to_active = high is not None
    bk.normal_space = "TANGENT"
    if high is not None:
        select_only(high, obj, active=obj)
        bpy.ops.object.bake(type=bake_type, margin=margin, use_clear=False, use_selected_to_active=True,
                            cage_extrusion=extrusion, max_ray_distance=distance)
    else:
        select_only(obj)
        bpy.ops.object.bake(type=bake_type, margin=margin, use_clear=clear is None)
    out = [np.array(i.pixels[:], np.float32).reshape(i.size[1], i.size[0], 4).astype(np.float64) for i in imgs]
    for slot, m in zip(slots, saved):
        nt = slot.material.node_tree
        if nt.nodes.get("__bake_target"):
            nt.nodes.remove(nt.nodes["__bake_target"])
        slot.material = m
    for m in temps:
        bpy.data.materials.remove(m)
    for i in imgs:
        bpy.data.images.remove(i)
    for o, h in hidden:
        o.hide_render = h
    bk.use_selected_to_active = False
    return out


def bake_attribute(obj, sizes, kind):
    """Position (POS), normale (NRM) ou attribut de sommet, par emplacement de matériau.
    Retourne une liste de (valeurs H×W×3, masque des texels couverts)."""
    res = bake_slots(obj, sizes, "EMIT", emit=kind, clear=-10.0)
    return [(a[..., :3], a[..., 0] > -9.0) for a in res]


def bake_ao(obj, sizes, samples=128, hide=()):
    return [a[..., 0] for a in bake_slots(obj, sizes, "AO", samples=samples, margin=8, hide=hide)]


def bake_normals_from(high, low, sizes, extrusion=0.0015, distance=0.004):
    res = bake_slots(low, sizes, "NORMAL", high=high, extrusion=extrusion, distance=distance)
    return [a[..., :3] * 2 - 1 for a in res]


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


def save_image(name, arr, path, srgb=True, alpha=None, fmt="PNG"):
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
    img.file_format = fmt
    if fmt == "WEBP":
        bpy.context.scene.render.image_settings.quality = 95
    img.save(quality=95) if fmt == "WEBP" else img.save()
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


def skin_maps(Pw, Nw, mask, ao, size, interior, micro):
    """Peint couleur et roughness de la peau pour une image (atlas du visage ou du reste).
    Pw / Nw : positions et normales monde (Blender) des texels ; micro : micro-relief
    (pores + sillons) en espace texture, qui assombrit et dépolit légèrement la peau.
    Retourne (couleur, roughness, poids des pores, masque des lèvres)."""
    P = topo.from_blender(Pw, BASE)
    N = np.stack([Nw[..., 0], -Nw[..., 1], Nw[..., 2]], -1)
    valid = mask
    p = P[valid]
    n = N[valid]
    sp = sym(p)

    lowf = noise.fbm3(p, 28.0, 3, seed=1)
    midf = noise.fbm3(p, 140.0, 3, seed=2)
    col = SKIN[None] * (1 + 0.06 * lowf[:, None] + 0.035 * midf[:, None])

    # zones de couleur du visage : front jaune, milieu rouge, bas bleuté (barbe, sang veineux)
    yellow = gauss(sp, (0.0, 0.095, 0.062), (0.040, 0.05, 0.024))
    blue = beard_mask(p) * 0.8 + 0.6 * gauss(sp, (0.030, 0.080, 0.006), (0.013, 0.02, 0.005))
    col *= 1 + yellow[:, None] * np.array([0.03, 0.035, -0.07])
    col *= 1 + np.clip(blue, 0, 1)[:, None] * np.array([-0.06, -0.03, 0.035])

    red = (0.60 * gauss(sp, (0.046, 0.074, -0.004), (0.016, 0.02, 0.016))
           + 0.75 * gauss(sp, (0.0, 0.110, -0.013), (0.010, 0.012, 0.010))
           + 0.65 * gauss(sp, (0.014, 0.098, -0.018), (0.008, 0.010, 0.008))
           + 0.60 * gauss(sp, (0.078, -0.010, 0.006), (0.020, 0.030, 0.035))
           + 0.30 * gauss(sp, (0.0, 0.095, -0.078), (0.014, 0.02, 0.012))
           + 0.30 * gauss(sp, (0.032, 0.080, 0.028), (0.016, 0.02, 0.006))
           + 0.20 * gauss(sp, (0.0, 0.095, 0.062), (0.03, 0.04, 0.02)))
    red *= 1 + 0.45 * noise.fbm3(p, 90.0, 3, seed=3)
    # capillaires autour des ailes du nez et sur les joues
    capi = np.clip(noise.fbm3(p, 700.0, 2, seed=12) * 2.5 - 1.0, 0, 1)
    red += 0.5 * capi * (gauss(sp, (0.018, 0.094, -0.016), (0.010, 0.02, 0.010))
                         + 0.5 * gauss(sp, (0.042, 0.075, -0.006), (0.014, 0.02, 0.012)))
    col = col * (1 - 0.40 * red[:, None]) + RED[None] * 0.40 * red[:, None]

    # veines discrètes (tempes, paupières, front)
    vr = 1 - np.abs(noise.fbm3(p * np.array([1.0, 1.0, 1.6]), 160.0, 3, seed=13))
    vmask = (gauss(sp, (0.066, 0.040, 0.040), (0.010, 0.03, 0.020))
             + 0.7 * gauss(sp, (0.032, 0.083, 0.027), (0.012, 0.02, 0.005))
             + 0.4 * gauss(sp, (0.020, 0.096, 0.060), (0.012, 0.03, 0.015)))
    vein = sdf.smoothstep(0.90, 0.975, vr) * np.clip(vmask, 0, 1)
    col = col * (1 - 0.16 * vein[:, None]) + np.array([0.36, 0.26, 0.40])[None] * 0.16 * vein[:, None]

    # cernes discrètes
    dark = gauss(sp, (0.031, 0.079, 0.008), (0.012, 0.02, 0.0045))
    col *= (1 - 0.14 * dark)[:, None] * np.array([1.0, 0.97, 1.02])

    # taches de rousseur légères et grains de beauté
    frk = np.clip(noise.fbm3(p, 1500.0, 2, seed=14) * 3.0 - 1.6, 0, 1)
    frk *= gauss(sp, (0.025, 0.095, -0.004), (0.025, 0.03, 0.020))
    col *= (1 - 0.18 * frk)[:, None] * np.array([1.0, 0.96, 0.92])
    rng = np.random.default_rng(31)
    moles = np.array([[0.041, 0.072, -0.020], [-0.035, 0.083, -0.043], [0.060, 0.040, -0.060],
                      [-0.052, 0.060, 0.030], [0.012, 0.093, 0.071], [-0.046, -0.010, -0.110],
                      [0.050, 0.030, -0.120], [-0.020, 0.090, -0.072]])
    for m in moles:
        r = rng.uniform(0.0005, 0.0012)
        dm = np.linalg.norm(p - m, axis=1)
        mm = 1 - sdf.smoothstep(r * 0.5, r, dm)
        col = col * (1 - 0.65 * mm[:, None]) + np.array([0.20, 0.10, 0.06])[None] * 0.65 * mm[:, None]

    # barbe de quelques jours
    beard = beard_mask(p)
    folli = noise.fbm3(p, 2200.0, 2, seed=4)
    stub = beard * np.clip(0.50 + 0.9 * folli, 0, 1)
    col = col * (1 - 0.50 * stub[:, None]) + STUBBLE[None] * 0.50 * stub[:, None]

    # cuir chevelu (cheveux ras sous les mèches) et sourcils
    hm = sdf.smoothstep(-0.003, 0.006, hair.hair_mask(p))
    hdots = np.clip(0.6 + 0.8 * noise.fbm3(p, 2600.0, 2, seed=5), 0, 1)
    scalp = hm * (0.55 + 0.45 * hdots) * sdf.smoothstep(0.0, 0.004, hair.hair_mask(p) + 0.002)
    col = col * (1 - 0.92 * scalp[:, None]) + SCALP[None] * 0.92 * scalp[:, None]
    brow = hair.brow_mask(p) * np.clip(0.5 + noise.fbm3(p, 1800.0, 2, seed=6), 0, 1)
    col = col * (1 - 0.68 * brow[:, None]) + SCALP[None] * 0.45 * 0.68 * brow[:, None]

    # lèvres : vermillon plus sombre aux commissures, liseré clair au bord
    lips = lip_masks(p)
    lipc = LIP[None] * (1 + 0.10 * midf[:, None])
    corner = sdf.smoothstep(0.012, 0.024, np.abs(p[:, 0]))
    lipc *= (1 - 0.18 * corner)[:, None]
    col = col * (1 - lips[:, None]) + lipc * lips[:, None]
    edge = lips * (1 - lips) * 4
    col *= (1 + 0.06 * edge)[:, None]

    # intérieurs : conjonctive, bouche, narines, conduit auditif
    inner = interior[valid]
    eyei = eye_interior(p) * np.clip(inner * 1.5, 0, 1)
    col = col * (1 - eyei[:, None]) + np.array([0.62, 0.30, 0.27])[None] * eyei[:, None]
    near_mouth = (np.abs(p[:, 0]) < 0.05) & (np.abs(p[:, 2] - hs.MOUTH_Z) < 0.04) & (p[:, 1] > 0.0)
    depth = np.clip((0.096 - 22 * p[:, 0] ** 2 - p[:, 1]) / 0.02, 0, 1)
    mouth_in = near_mouth & (inner > 0.5) & (eyei < 0.5)
    mcol = np.array([0.42, 0.13, 0.12])[None] * (1 - depth[:, None]) ** 1.5 + np.array([0.03, 0.006, 0.006])[None] * depth[:, None]
    col[mouth_in] = mcol[mouth_in]
    nost = np.maximum(gauss(sp, (0.0066, 0.1025, -0.0246), (0.0030, 0.0042, 0.0018)) * (n[:, 2] < -0.2), 0)
    col *= (1 - 0.85 * np.clip(nost * 1.6, 0, 1))[:, None]
    canal = (inner > 0.5) * (np.abs(p[:, 0]) > 0.05)
    col *= (1 - 0.8 * canal)[:, None]

    a = ao[valid]
    col *= (0.60 + 0.40 * a ** 0.6)[:, None]

    # roughness : zone T brillante, joues mates, lèvres humides, cuir chevelu mat
    rough = 0.58 + 0.05 * lowf
    tz = (gauss(sp, (0.0, 0.10, 0.065), (0.022, 0.05, 0.022)) * 0.17
          + gauss(sp, (0.0, 0.11, -0.005), (0.011, 0.03, 0.024)) * 0.22
          + gauss(sp, (0.0, 0.095, -0.080), (0.014, 0.02, 0.012)) * 0.10)
    rough -= tz
    rough += 0.04 * gauss(sp, (0.045, 0.072, -0.010), (0.016, 0.02, 0.016))
    rough = rough * (1 - lips) + (0.30 + 0.06 * midf) * lips
    rough = rough * (1 - scalp) + 0.68 * scalp
    rough = np.where(mouth_in, 0.20, rough)
    rough = rough * (1 - eyei) + 0.14 * eyei
    rough += 0.04 * noise.fbm3(p, 600.0, 2, seed=7)

    albedo = np.zeros(mask.shape + (3,))
    albedo[valid] = np.clip(col, 0, 1)
    R = np.zeros(mask.shape)
    R[valid] = np.clip(rough, 0.12, 0.9)
    pw = (0.55 + 0.7 * gauss(sp, (0.0, 0.11, -0.005), (0.02, 0.05, 0.02))
          + 0.5 * gauss(sp, (0.042, 0.075, -0.010), (0.02, 0.03, 0.02))
          + 0.3 * gauss(sp, (0.0, 0.098, 0.060), (0.03, 0.04, 0.02))) * (1 - lips) * (1 - scalp * 0.7)
    pw = np.where(mouth_in | (eyei > 0.5), 0.0, pw)
    pore_w = np.zeros(mask.shape)
    pore_w[valid] = pw
    lipm = np.zeros(mask.shape)
    lipm[valid] = lips
    # le micro-relief creuse (assombrit) et dépolit un peu la peau
    m = np.clip(-micro, 0, None)
    m /= max(m.max(), 1e-6)
    albedo *= (1 - 0.10 * m * pore_w)[..., None]
    R = np.clip(R + 0.10 * m * pore_w, 0.12, 0.9)
    return albedo, R, pore_w, lipm


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
    crease = np.exp(-((ang - 0.86) / 0.06) ** 2) * (r < 0.0180) * sdf.smoothstep(0.072, 0.078, f)
    d -= 0.00055 * crease
    # bourrelet de peau au-dessus du pli (repli palpébral)
    d += 0.00025 * np.exp(-((ang - 0.99) / 0.08) ** 2) * (r < 0.0185) * sdf.smoothstep(0.072, 0.078, f)
    # sillon alaire : arc autour de l'aile du nez
    ax, az = x - 0.0128, z + 0.0175
    rr = np.hypot(ax, az * 1.15)
    arc = (np.arctan2(az, ax) > -0.9) * sdf.smoothstep(0.088, 0.093, f)
    d -= 0.00040 * np.exp(-((rr - 0.0086) / 0.0010) ** 2) * arc
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
    # liseré du vermillon (« white roll ») : petit bourrelet au bord des lèvres
    d += 0.00014 * lm * (1 - lm) * 4
    # pli mento-labial
    d -= 0.00022 * np.exp(-((z + 0.0635) / 0.0025) ** 2) * np.exp(-(x / 0.016) ** 2) * sdf.smoothstep(0.085, 0.092, f)
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


def micro_relief(size, texel_mm):
    """Micro-relief de la peau en espace texture : pores (creux ~0,1 mm), sillons
    polygonaux (Voronoï ~0,65 mm) et grain fin. texel_mm : taille d'un texel en mm."""
    px = lambda mm: max(mm / texel_mm, 0.6)
    pores = noise.pores2((size, size), 0.9 * texel_mm ** 2, px(0.10), seed=21)
    vor = noise.voronoi_edges((size, size), max(int(px(0.65)), 3), seed=24)
    grooves = -np.exp(-(vor / px(0.06)) ** 2)
    grain = noise.fbm2((size, size), px(0.25), 2, seed=22)
    return 0.55 * pores + 0.45 * grooves + 0.18 * grain


def pore_normal(micro, weight, lipm, texel_mm, strength=1.0):
    H = micro * weight
    size = micro.shape[0]
    # stries verticales des lèvres
    H += 0.35 * lipm * noise.fbm2((size, size), max(0.4 / texel_mm, 1.0), 1, seed=23)
    return height_to_normal(H, 0.8 * strength * min(1.0, 0.12 / texel_mm))


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
