"""Bruits procéduraux vectorisés (numpy) : valeur 2D/3D, fBm, cellulaire simple."""
import numpy as np

_rng = np.random.default_rng(1234)
PERM = _rng.permutation(4096)
VALS = _rng.uniform(-1, 1, 4096)


def _hash3(i, j, k):
    return PERM[(PERM[(PERM[i & 4095] + j) & 4095] + k) & 4095]


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def value3(p, freq=1.0, seed=0):
    """Bruit de valeur 3D lisse dans [-1, 1] ; p : (..., 3) en mètres, freq en 1/m."""
    q = p * freq + seed * 17.13
    i = np.floor(q).astype(np.int64)
    f = q - i
    u = _fade(f)
    out = 0.0
    for dx in (0, 1):
        wx = u[..., 0] if dx else 1 - u[..., 0]
        for dy in (0, 1):
            wy = u[..., 1] if dy else 1 - u[..., 1]
            for dz in (0, 1):
                wz = u[..., 2] if dz else 1 - u[..., 2]
                h = _hash3(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz)
                out = out + VALS[h] * wx * wy * wz
    return out


def fbm3(p, freq, octaves=4, gain=0.5, lac=2.03, seed=0):
    amp, total, norm = 1.0, 0.0, 0.0
    for o in range(octaves):
        total = total + amp * value3(p, freq * lac ** o, seed + o)
        norm += amp
        amp *= gain
    return total / norm


def value2(shape, cell, seed=0):
    """Bruit de valeur 2D lisse (grille de pixels), période en pixels."""
    h, w = shape
    rng = np.random.default_rng(seed)
    gh, gw = int(np.ceil(h / cell)) + 2, int(np.ceil(w / cell)) + 2
    g = rng.uniform(-1, 1, (gh, gw))
    y = np.arange(h) / cell
    x = np.arange(w) / cell
    yi, xi = np.floor(y).astype(int), np.floor(x).astype(int)
    fy, fx = _fade(y - yi)[:, None], _fade(x - xi)[None, :]
    a = g[yi][:, xi]
    b = g[yi][:, xi + 1]
    c = g[yi + 1][:, xi]
    d = g[yi + 1][:, xi + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm2(shape, cell, octaves=4, gain=0.5, seed=0):
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * value2(shape, max(cell / 2 ** o, 1.0), seed + o)
        norm += amp
        amp *= gain
    return total / norm


def pores2(shape, density, radius, seed=0):
    """Carte de petits creux (pores) : somme de gaussiennes négatives placées au hasard."""
    h, w = shape
    rng = np.random.default_rng(seed)
    n = int(h * w * density)
    out = np.zeros(shape)
    ys = rng.integers(0, h, n)
    xs = rng.integers(0, w, n)
    amp = rng.uniform(0.5, 1.0, n)
    r = int(np.ceil(radius * 2.5))
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            wgt = np.exp(-(dx * dx + dy * dy) / (2 * radius * radius))
            np.add.at(out, ((ys + dy) % h, (xs + dx) % w), -amp * wgt)
    return out


def voronoi_edges(shape, cell, seed=0, block=256):
    """Distance F2 − F1 d'un diagramme de Voronoï (une cellule ~ `cell` px) : réseau de
    sillons polygonaux, comme le micro-relief de la peau. Retourne un tableau en pixels."""
    h, w = shape
    rng = np.random.default_rng(seed)
    gh, gw = int(np.ceil(h / cell)) + 2, int(np.ceil(w / cell)) + 2
    jit = rng.uniform(0, 1, (gh, gw, 2))
    out = np.zeros(shape, np.float32)
    xs = np.arange(w)
    for y0 in range(0, h, block):
        ys = np.arange(y0, min(y0 + block, h))
        Y, X = np.meshgrid(ys, xs, indexing="ij")
        cy, cx = Y // cell, X // cell
        f1 = np.full(Y.shape, 1e9, np.float32)
        f2 = np.full(Y.shape, 1e9, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                gy = np.clip(cy + dy, 0, gh - 1)
                gx = np.clip(cx + dx, 0, gw - 1)
                py = (gy + jit[gy, gx, 0]) * cell
                px = (gx + jit[gy, gx, 1]) * cell
                d = np.hypot(py - Y, px - X).astype(np.float32)
                f2 = np.where(d < f1, f1, np.minimum(f2, d))
                f1 = np.minimum(f1, d)
        out[ys[0]:ys[-1] + 1] = f2 - f1
    return out
