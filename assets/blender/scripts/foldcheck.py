import sys; sys.path.insert(0, r"D:\DEV\AVATARS\assets\blender\scripts")
import numpy as np, build_head as bh, head_shape as hs
bm, loops, P = bh.build()
bad = []
for f in bm.faces:
    pts = np.array([P[v.index] for v in f.verts])
    c = pts.mean(0)
    nrm = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    g = bh.gradient(c[None])[0]
    if np.dot(nrm, g) < 0 and c[1] > 0.03:
        bad.append(np.round(c * 1000, 1))
print("FOLDS", len(bad), [tuple(b) for b in bad])
