"""Primitives de champs de distance signée (SDF) vectorisées avec numpy.

Repère « anatomique » utilisé partout dans les scripts : x vers la gauche du personnage,
f vers l'avant (le personnage regarde vers +f), z vers le haut. Unités : mètres.
Origine : milieu des deux tragus (devant les oreilles), à leur hauteur.
Blender : y = -f (le personnage regarde vers -Y, donc +Z en glTF).
"""
import numpy as np


def length(v):
    return np.sqrt(np.sum(v * v, axis=-1))


def smin(a, b, k):
    """Union lisse (polynomiale) de rayon k."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    """Intersection lisse ; smax(a, -b, k) soustrait b de a."""
    return -smin(-a, -b, k)


def sphere(p, c, r):
    return length(p - np.asarray(c)) - r


def ellipsoid(p, c, r):
    q = (p - np.asarray(c)) / np.asarray(r)
    k0 = length(q)
    k1 = length(q / np.asarray(r))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def cone_capsule(p, a, b, ra, rb):
    """Capsule à rayon variable (approximation suffisante pour des unions lisses)."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    pa = p - a
    ba = b - a
    h = np.clip(np.sum(pa * ba, axis=-1) / np.dot(ba, ba), 0.0, 1.0)
    return length(pa - ba * h[..., None]) - (ra + (rb - ra) * h)


def pchip(xs, ys, x):
    """Interpolation cubique monotone (Fritsch-Carlson), extrapolation constante."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    for i in range(1, len(xs) - 1):
        if d[i - 1] * d[i] > 0:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    m[0] = d[0]
    m[-1] = d[-1]
    xc = np.clip(x, xs[0], xs[-1])
    i = np.clip(np.searchsorted(xs, xc) - 1, 0, len(xs) - 2)
    t = (xc - xs[i]) / h[i]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
            + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)
