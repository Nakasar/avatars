"""Squelette (Hips, Spine, Spine1, Spine2, Neck, Head, LeftEye, RightEye, Jaw) et poids."""
import numpy as np
import bpy
from mathutils import Vector

import head_shape as hs
import parts
import topo
import sdf
import build_head as bh

BASE = bh.BASE


def bl(p):
    return Vector(topo.to_blender(np.asarray(p, float), BASE).tolist())


def build_armature(col):
    arm = bpy.data.armatures.new("Armature")
    ob = bpy.data.objects.new("Armature", arm)
    col.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.view_layer.objects:
        o.select_set(o == ob)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones

    def bone(name, head, tail, parent=None):
        b = eb.new(name)
        b.head = bl(head)
        b.tail = bl(tail)
        b.roll = 0.0
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        return b

    bone("Hips", (0, -0.020, -0.62), (0, -0.020, -0.52))
    bone("Spine", (0, -0.020, -0.52), (0, -0.020, -0.42), "Hips")
    bone("Spine1", (0, -0.020, -0.42), (0, -0.022, -0.31), "Spine")
    bone("Spine2", (0, -0.022, -0.31), (0, -0.024, -0.16), "Spine1")
    bone("Neck", (0, -0.024, -0.16), (0, -0.012, -0.045), "Spine2")
    bone("Head", (0, -0.012, -0.045), (0, -0.012, 0.130), "Neck")
    for s, name in ((1, "LeftEye"), (-1, "RightEye")):
        c = hs.EYE_C * np.array([s, 1, 1])
        bone(name, c, c + np.array([0, 0.022, 0]), "Head")
    bone("Jaw", parts.JAW_PIVOT, (0, 0.085, -0.085), "Head")
    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


def assign(obj, arm, weights):
    """weights : dict nom d'os → tableau de poids par sommet."""
    obj.vertex_groups.clear()
    n = len(obj.data.vertices)
    total = np.zeros(n)
    for w in weights.values():
        total += w
    total = np.maximum(total, 1e-6)
    for name, w in weights.items():
        vg = obj.vertex_groups.new(name=name)
        w = w / total
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    obj.parent = arm


def anat(obj):
    co = np.zeros(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    return topo.from_blender(co.reshape(-1, 3), BASE)


def skin_weights(body, jaw):
    P = anat(body)
    x, f, z = P[:, 0], P[:, 1], P[:, 2]
    t = z + 0.35 * np.maximum(f, 0)
    head = sdf.smoothstep(-0.115, -0.070, t)
    spine2 = 1 - sdf.smoothstep(-0.185, -0.135, z)
    neck = np.clip(1 - head - spine2, 0, 1)
    j = np.zeros(len(P))
    j[:len(jaw)] = jaw
    jw = j * head
    return {"Head": head - jw, "Jaw": jw, "Neck": neck, "Spine2": spine2}


def shirt_weights(shirt):
    P = anat(shirt)
    z = P[:, 2]
    up = sdf.smoothstep(-0.36, -0.24, z)
    return {"Spine2": up, "Spine1": 1 - up}
