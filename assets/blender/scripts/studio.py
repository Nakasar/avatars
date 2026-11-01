"""Plateau de rendu de contrôle : caméra portrait, éclairage trois points, Cycles GPU."""
import math
import bpy
from mathutils import Vector


def enable_gpu():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            for d in prefs.devices:
                d.use = d.type != "CPU"
            return backend
        except TypeError:
            continue
    return "CPU"


def setup(samples=96, res=900):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    enable_gpu()
    scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.18, 0.19, 0.21, 1)
    bg.inputs[1].default_value = 0.35

    for name in ("Cube", "Light", "Camera"):
        o = bpy.data.objects.get(name)
        if o:
            bpy.data.objects.remove(o)

    def area(name, loc, energy, size, color):
        lamp = bpy.data.lights.get(name) or bpy.data.lights.new(name, "AREA")
        lamp.energy = energy
        lamp.size = size
        lamp.color = color
        ob = bpy.data.objects.get(name) or bpy.data.objects.new(name, lamp)
        if ob.name not in scene.collection.objects:
            scene.collection.objects.link(ob)
        ob.location = loc
        target = Vector((0, 0, 1.6))
        ob.rotation_euler = (target - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return ob

    area("StudioKey", (-0.9, -1.1, 2.1), 160, 0.9, (1.0, 0.95, 0.9))
    area("StudioFill", (1.2, -0.9, 1.6), 45, 1.4, (0.9, 0.95, 1.0))
    area("StudioRim", (0.4, 1.2, 2.0), 90, 0.6, (1.0, 1.0, 1.0))

    cam = bpy.data.cameras.get("StudioCam") or bpy.data.cameras.new("StudioCam")
    cam.lens = 85
    cam.clip_start = 0.005
    cam.sensor_width = 36
    cob = bpy.data.objects.get("StudioCam") or bpy.data.objects.new("StudioCam", cam)
    if cob.name not in scene.collection.objects:
        scene.collection.objects.link(cob)
    scene.camera = cob
    return cob


def shoot(path, yaw_deg, target=(0, 0, 1.6), dist=1.05, pitch_deg=0.0, lens=85):
    """Place la caméra autour de la cible (yaw 0 = de face) et rend une image."""
    scene = bpy.context.scene
    cob = scene.camera
    cob.data.lens = lens
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    t = Vector(target)
    # le personnage regarde vers -Y : la caméra de face est en -Y
    off = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch))) * dist
    cob.location = t + off
    cob.rotation_euler = (t - cob.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def montage(paths, out):
    """Assemble des rendus côte à côte (numpy, sans dépendance externe)."""
    import numpy as np
    arrs = []
    for p in paths:
        im = bpy.data.images.load(p)
        a = np.array(im.pixels[:], dtype=np.float32).reshape(im.size[1], im.size[0], 4)
        arrs.append(a)
        bpy.data.images.remove(im)
    h = max(a.shape[0] for a in arrs)
    arrs = [np.pad(a, ((0, h - a.shape[0]), (0, 0), (0, 0))) for a in arrs]
    m = np.concatenate(arrs, axis=1)
    img = bpy.data.images.new("montage", m.shape[1], m.shape[0], alpha=True)
    img.pixels.foreach_set(m.ravel())
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    return out
