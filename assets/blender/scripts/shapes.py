"""Shape keys : 52 blendshapes ARKit + 15 visèmes Oculus, calculés comme des champs de
déplacement dans le repère anatomique.

- mâchoire : rotation autour de l'axe des ATM, pondérée par le poids « jaw » ;
- paupières : rotation autour du centre du globe (le bord libre glisse sur l'œil) ;
- lèvres, joues, nez, sourcils : déplacements pondérés par des régions anatomiques.
Les dents, la langue, les cils et les sourcils suivent (mêmes noms de shape keys).
"""
import numpy as np

import head_shape as hs
import parts
import sdf

ARKIT = [
    "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft",
    "eyeSquintLeft", "eyeWideLeft", "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight",
    "eyeLookOutRight", "eyeLookUpRight", "eyeSquintRight", "eyeWideRight",
    "jawForward", "jawLeft", "jawRight", "jawOpen",
    "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight",
    "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
    "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
    "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
    "mouthUpperUpLeft", "mouthUpperUpRight",
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft", "noseSneerRight",
    "tongueOut",
]

# composition des visèmes (identique à VISEME_TO_ARKIT dans src/avatar/visemes.ts)
VISEMES = {
    "viseme_sil": {},
    "viseme_PP": {"mouthClose": 0.35, "mouthPressLeft": 0.55, "mouthPressRight": 0.55, "mouthRollLower": 0.25, "jawOpen": 0.05},
    "viseme_FF": {"mouthRollLower": 0.6, "mouthUpperUpLeft": 0.25, "mouthUpperUpRight": 0.25, "jawOpen": 0.08, "mouthFunnel": 0.05},
    "viseme_TH": {"jawOpen": 0.15, "tongueOut": 0.35, "mouthLowerDownLeft": 0.1, "mouthLowerDownRight": 0.1},
    "viseme_DD": {"jawOpen": 0.2, "mouthStretchLeft": 0.15, "mouthStretchRight": 0.15, "mouthShrugUpper": 0.15},
    "viseme_kk": {"jawOpen": 0.25, "mouthStretchLeft": 0.2, "mouthStretchRight": 0.2},
    "viseme_CH": {"mouthFunnel": 0.5, "mouthPucker": 0.2, "jawOpen": 0.15, "mouthUpperUpLeft": 0.2, "mouthUpperUpRight": 0.2},
    "viseme_SS": {"jawOpen": 0.06, "mouthStretchLeft": 0.35, "mouthStretchRight": 0.35, "mouthSmileLeft": 0.1, "mouthSmileRight": 0.1},
    "viseme_nn": {"jawOpen": 0.15, "mouthClose": 0.1, "mouthStretchLeft": 0.1, "mouthStretchRight": 0.1},
    "viseme_RR": {"mouthFunnel": 0.3, "mouthPucker": 0.25, "jawOpen": 0.15},
    "viseme_aa": {"jawOpen": 0.55, "mouthLowerDownLeft": 0.3, "mouthLowerDownRight": 0.3, "mouthUpperUpLeft": 0.1, "mouthUpperUpRight": 0.1},
    "viseme_E": {"jawOpen": 0.3, "mouthStretchLeft": 0.35, "mouthStretchRight": 0.35, "mouthSmileLeft": 0.15, "mouthSmileRight": 0.15},
    "viseme_I": {"jawOpen": 0.15, "mouthStretchLeft": 0.45, "mouthStretchRight": 0.45, "mouthSmileLeft": 0.25, "mouthSmileRight": 0.25},
    "viseme_O": {"jawOpen": 0.4, "mouthFunnel": 0.55, "mouthPucker": 0.2},
    "viseme_U": {"jawOpen": 0.12, "mouthPucker": 0.75, "mouthFunnel": 0.3},
}

JAW_OPEN_DEG = 21.0
JAW_KEYS = {"jawOpen", "jawForward", "jawLeft", "jawRight"}


def gauss(p, c, s):
    q = (p - np.asarray(c)) / np.asarray(s)
    return np.exp(-0.5 * np.sum(q * q, -1))


def rot_x_about(p, centre, ang):
    """Rotation dans le plan (f, z) autour d'un axe parallèle à x ; ang par sommet."""
    q = p - centre
    c, s = np.cos(ang), np.sin(ang)
    out = p.copy()
    out[:, 1] = centre[1] + q[:, 1] * c - q[:, 2] * s
    out[:, 2] = centre[2] + q[:, 1] * s + q[:, 2] * c
    return out


class FaceRig:
    """Calcule les déplacements de la peau pour chaque blendshape."""

    def __init__(self, P, roles, margins):
        self.P = P
        self.r = roles
        x = P[:, 0]
        self.sp = P.copy()
        self.sp[:, 0] = np.abs(x)
        self.side = {1: sdf.smoothstep(-0.004, 0.004, x), -1: sdf.smoothstep(-0.004, 0.004, -x)}
        self.margins = margins
        self.corner = {}
        for s in (1, -1):
            self.corner[s] = np.array([s * hs.MOUTH_W, 0.0888, hs.MOUTH_Z - 0.0008])

    # --- outils -------------------------------------------------------------------------
    def _margin_angles(self, s):
        c = hs.EYE_C * np.array([s, 1, 1])
        out = {}
        for k in ("up", "lo"):
            m = self.margins[f"eye{s}_{k}"]
            a = np.arctan2(m[:, 2] - c[2], m[:, 1] - c[1])
            out[k] = (np.abs(m[:, 0]), a)
        return c, out

    def lids(self, s, up_amt=None, lo_amt=None, close=0.0):
        """Rotation des paupières. close ∈ [0, 1] : fermeture (clignement) ; up_amt /
        lo_amt : rotation supplémentaire (rad) des paupières supérieure / inférieure."""
        tag = "L" if s > 0 else "R"
        wu, wl = self.r[f"lid_up_{tag}"], self.r[f"lid_lo_{tag}"]
        c, ang = self._margin_angles(s)
        ax = np.abs(self.P[:, 0])
        xu, au = ang["up"]
        xl, al = ang["lo"]
        ou, ol = np.argsort(xu), np.argsort(xl)
        a_up = np.interp(ax, xu[ou], au[ou])
        a_lo = np.interp(ax, xl[ol], al[ol])
        meet = a_lo + 0.28 * (a_up - a_lo)
        phi_u = (meet - a_up) * close * wu
        phi_l = (meet - a_lo) * close * wl
        if up_amt:
            phi_u = phi_u + up_amt * wu
        if lo_amt:
            phi_l = phi_l + lo_amt * wl
        phi = phi_u + phi_l
        return rot_x_about(self.P, c, phi) - self.P

    def jaw(self, deg):
        J = self.r["jaw"]
        ang = -np.radians(deg) * J
        return rot_x_about(self.P, parts.JAW_PIVOT, ang) - self.P

    # --- blendshapes ----------------------------------------------------------------------
    def delta(self, name, amount=1.0):
        P, sp, r = self.P, self.sp, self.r
        z = np.zeros_like(P)
        ul, ll = r["lip_upper"], r["lip_lower"]
        lips = np.maximum(ul, ll)
        J = r["jaw"]

        def vec(w, v):
            return w[:, None] * np.asarray(v)[None] * amount

        def sided(base):
            for s, lab in ((1, "Left"), (-1, "Right")):
                if name.endswith(lab):
                    return s
            return None

        s = sided(name)
        if name.startswith("eyeBlink"):
            return self.lids(s, close=1.0 * amount)
        if name.startswith("eyeLookUp"):
            return self.lids(s, up_amt=0.12 * amount, lo_amt=0.07 * amount)
        if name.startswith("eyeLookDown"):
            return self.lids(s, up_amt=-0.24 * amount, lo_amt=-0.08 * amount)
        if name.startswith("eyeLookIn") or name.startswith("eyeLookOut"):
            tag = "L" if s > 0 else "R"
            w = np.maximum(r[f"lid_up_{tag}"], r[f"lid_lo_{tag}"])
            sign = -s if "In" in name else s
            return vec(w, (sign * 0.0012, 0, 0))
        if name.startswith("eyeSquint"):
            cheek = gauss(sp, (0.038, 0.080, 0.000), (0.012, 0.02, 0.008)) * self.side[s]
            return self.lids(s, up_amt=-0.05 * amount, lo_amt=0.16 * amount) + vec(cheek, (0, 0.0006, 0.0014))
        if name.startswith("eyeWide"):
            brow = gauss(sp, (0.032, 0.088, 0.040), (0.02, 0.03, 0.012)) * self.side[s]
            return self.lids(s, up_amt=0.13 * amount) + vec(brow, (0, 0, 0.0012))
        if name == "jawOpen":
            return self.jaw(JAW_OPEN_DEG * amount)
        if name == "jawForward":
            return vec(J, (0, 0.0045, 0))
        if name == "jawLeft":
            return vec(J, (0.0045, 0, 0))
        if name == "jawRight":
            return vec(J, (-0.0045, 0, 0))

        cs = {k: gauss(P, self.corner[k], (0.011, 0.014, 0.010)) for k in (1, -1)}
        if name == "mouthClose":
            return vec(ll ** 1.5, (0, 0.0010, 0.0045)) + vec(ul ** 1.5, (0, 0, -0.0010))
        if name == "mouthFunnel":
            ctr = np.exp(-(P[:, 0] / 0.016) ** 2)
            d = vec(lips, (0, 0.0035, 0)) + vec(ul * ctr, (0, 0, 0.0020)) + vec(ll * ctr, (0, 0, -0.0024))
            d[:, 0] += -0.28 * P[:, 0] * lips * amount
            return d
        if name == "mouthPucker":
            d = vec(lips, (0, 0.0058, 0))
            d[:, 0] += -0.42 * P[:, 0] * lips * amount
            return d
        if name in ("mouthLeft", "mouthRight"):
            m = gauss(P, (0, 0.090, hs.MOUTH_Z), (0.030, 0.04, 0.018))
            return vec(m, ((0.0048 if name == "mouthLeft" else -0.0048), -0.0005, 0))
        if name.startswith("mouthSmile"):
            cheek = gauss(sp, (0.040, 0.078, -0.012), (0.014, 0.02, 0.014)) * self.side[s]
            tag = "L" if s > 0 else "R"
            wide = gauss(P, self.corner[s], (0.018, 0.020, 0.016))
            return (vec(cs[s], (s * 0.0045, -0.0040, 0.0060)) + vec(wide, (s * 0.0020, -0.0010, 0.0030))
                    + vec(cheek, (0, 0.0020, 0.0040)) + vec(r[f"lid_lo_{tag}"], (0, 0, 0.0012)))
        if name.startswith("mouthFrown"):
            return vec(cs[s], (s * 0.0010, -0.0004, -0.0042))
        if name.startswith("mouthStretch"):
            return vec(cs[s], (s * 0.0050, -0.0015, -0.0012)) + vec(ll * self.side[s], (0, 0, -0.0008))
        if name.startswith("mouthDimple"):
            return vec(cs[s], (s * 0.0012, -0.0030, 0.0004))
        if name == "mouthRollLower":
            return vec(ll ** 2, (0, -0.0032, 0.0012))
        if name == "mouthRollUpper":
            return vec(ul ** 2, (0, -0.0030, -0.0012))
        if name == "mouthShrugLower":
            chin = gauss(P, (0, 0.094, -0.080), (0.016, 0.02, 0.012))
            return vec(ll, (0, 0.0008, 0.0022)) + vec(chin, (0, 0.0010, 0.0016))
        if name == "mouthShrugUpper":
            return vec(ul, (0, 0.0005, 0.0018))
        if name.startswith("mouthPress"):
            keep = 1 - np.maximum(cs[1], cs[-1]) * 0.5
            return (vec(ul * self.side[s] * keep, (0, -0.0008, -0.0007))
                    + vec(ll * self.side[s] * keep, (0, -0.0008, 0.0007)))
        if name.startswith("mouthLowerDown"):
            w = ll * self.side[s] * gauss(sp, (0.010, 0.1, 0), (0.014, 1, 1))
            return vec(w, (0, 0.0005, -0.0034))
        if name.startswith("mouthUpperUp"):
            w = ul * self.side[s] * gauss(sp, (0.011, 0.1, 0), (0.013, 1, 1))
            return vec(w, (0, 0.0005, 0.0032))
        if name.startswith("browDown"):
            b = gauss(sp, (0.028, 0.090, 0.039), (0.020, 0.03, 0.013)) * self.side[s]
            inner = gauss(sp, (0.014, 0.094, 0.036), (0.010, 0.03, 0.012)) * self.side[s]
            return vec(b, (0, 0.0008, -0.0034)) + vec(inner, (-s * 0.0016, 0, -0.0006))
        if name == "browInnerUp":
            b = gauss(sp, (0.016, 0.093, 0.040), (0.011, 0.03, 0.014))
            fore = gauss(sp, (0.0, 0.098, 0.060), (0.025, 0.04, 0.014))
            return vec(b, (0, 0, 0.0045)) + vec(fore, (0, 0, 0.0012))
        if name.startswith("browOuterUp"):
            b = gauss(sp, (0.044, 0.081, 0.041), (0.013, 0.03, 0.013)) * self.side[s]
            return vec(b, (0, 0, 0.0045))
        if name == "cheekPuff":
            c = gauss(sp, (0.044, 0.064, -0.036), (0.015, 0.02, 0.015))
            d = vec(c, (0, 0.0020, 0))
            d[:, 0] += np.sign(P[:, 0]) * c * 0.0045 * amount
            return d
        if name.startswith("cheekSquint"):
            cheek = gauss(sp, (0.042, 0.075, -0.004), (0.014, 0.02, 0.012)) * self.side[s]
            tag = "L" if s > 0 else "R"
            return vec(cheek, (0, 0.0008, 0.0026)) + self.lids(s, lo_amt=0.06 * amount)
        if name.startswith("noseSneer"):
            n = gauss(sp, (0.015, 0.098, -0.012), (0.008, 0.010, 0.008)) * self.side[s]
            lip = ul * self.side[s] * gauss(sp, (0.012, 0.1, 0), (0.012, 1, 1))
            return vec(n, (0, 0.0004, 0.0026)) + vec(lip, (0, 0, 0.0012))
        if name == "tongueOut":
            return z
        raise KeyError(name)

    def combo(self, weights):
        d = np.zeros_like(self.P)
        for k, w in weights.items():
            d += self.delta(k, w)
        return d


def rigid_delta(P, name_weights, jaw_deg=JAW_OPEN_DEG, jaw=True, tongue=False):
    """Dents inférieures / langue : seuls les mouvements de mâchoire (et la langue)."""
    d = np.zeros_like(P)
    for k, w in name_weights.items():
        if k == "jawOpen" and jaw:
            d += rot_x_about(P, parts.JAW_PIVOT, np.full(len(P), -np.radians(jaw_deg * w))) - P
        elif k == "jawForward" and jaw:
            d += np.array([0, 0.0045, 0]) * w
        elif k == "jawLeft" and jaw:
            d += np.array([0.0045, 0, 0]) * w
        elif k == "jawRight" and jaw:
            d += np.array([-0.0045, 0, 0]) * w
        elif k == "tongueOut" and tongue:
            tip = sdf.smoothstep(0.050, 0.085, P[:, 1])
            d += (np.array([0, 0.016, -0.004])[None] * (0.4 + 0.6 * tip)[:, None]) * w
    return d


def all_targets():
    """Liste ordonnée (nom, poids ARKit) : 52 ARKit puis 15 visèmes."""
    out = [(n, {n: 1.0}) for n in ARKIT]
    out += list(VISEMES.items())
    return out


def kabsch(A, B):
    """Rotation optimale qui envoie les vecteurs A sur B (lignes)."""
    H = A.T @ B
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1, 1, d])
    return Vt.T @ D @ U.T


def transfer(P_body, D_body, nbrs, idx, P_acc):
    """Déplacements d'accessoires (cils, sourcils) collés à la peau : translation du
    sommet de peau le plus proche + rotation locale estimée sur son 1-voisinage."""
    out = np.zeros_like(P_acc)
    cache = {}
    for i in range(len(P_acc)):
        b = idx[i]
        if b not in cache:
            ring = nbrs[b]
            A = P_body[ring] - P_body[b]
            B = (P_body[ring] + D_body[ring]) - (P_body[b] + D_body[b])
            cache[b] = kabsch(A, B) if len(ring) >= 2 and np.abs(D_body[ring]).max() > 1e-7 else np.eye(3)
        Rm = cache[b]
        rp = P_body[b]
        out[i] = D_body[b] + (Rm @ (P_acc[i] - rp)) - (P_acc[i] - rp)
    return out
