"""Génération de topologie : sphère-cube en quads et utilitaires de maillage."""
import numpy as np


def cube_sphere(n):
    """Sphère-cube de n×n quads par face. Retourne (directions unitaires, faces quads)."""
    verts = {}
    pos = []
    faces = []

    def vid(p):
        key = tuple(np.round(p * n).astype(int))
        if key not in verts:
            verts[key] = len(pos)
            pos.append(p)
        return verts[key]

    lin = np.linspace(-1, 1, n + 1)
    axes = [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
    for a, b, c in axes:
        for sign in (-1, 1):
            grid = np.zeros((n + 1, n + 1), int)
            for i, u in enumerate(lin):
                for j, v in enumerate(lin):
                    p = np.zeros(3)
                    p[a] = sign
                    p[b] = u
                    p[c] = v
                    grid[i, j] = vid(p)
            for i in range(n):
                for j in range(n):
                    q = [grid[i, j], grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1]]
                    if sign < 0:
                        q = q[::-1]
                    faces.append(q)
    p = np.array(pos)
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    # projection « équi-aire » du cube sur la sphère (quads plus réguliers)
    sx = x * np.sqrt(1 - y * y / 2 - z * z / 2 + y * y * z * z / 3)
    sy = y * np.sqrt(1 - z * z / 2 - x * x / 2 + z * z * x * x / 3)
    sz = z * np.sqrt(1 - x * x / 2 - y * y / 2 + x * x * y * y / 3)
    d = np.stack([sx, sy, sz], 1)
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return d, faces


def rot_x(deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def to_blender(p, base=(0.0, 0.0, 0.0)):
    """Repère anatomique (x, f, z) → Blender (x, -f, z) + décalage."""
    q = np.stack([p[..., 0], -p[..., 1], p[..., 2]], -1)
    return q + np.asarray(base)


def from_blender(q, base=(0.0, 0.0, 0.0)):
    q = q - np.asarray(base)
    return np.stack([q[..., 0], -q[..., 1], q[..., 2]], -1)
