#!/usr/bin/env python3
"""Mean brightness of the model's sky (scripts/gpano.mjs) and of the survey within a circle on the sky, after
the same scaling as pano_compare.py (median over |b| < 30 deg matched): how bright an object is next to the
Milky Way, e.g. the Magellanic Clouds.

    .texvenv/bin/python -I scripts/textures/pano_spot.py <model.f32> <survey.exr> L B RADIUS_DEG [L B R ...]
"""
import os
import sys

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402

raw = np.fromfile(sys.argv[1], dtype=np.float32)
w = int(round(np.sqrt(raw.size / 2))); h = w // 2
model = raw.reshape(h, w, 4)[::-1, :, :3].mean(axis=2)
sv = cv2.resize(cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED)[..., :3].astype(np.float32), (w, h), interpolation=cv2.INTER_AREA).mean(axis=2)
b = (0.5 - (np.arange(h) + 0.5) / h) * 180
lon = (0.5 - (np.arange(w) + 0.5) / w) * 360
band = np.abs(b) < 30
model *= np.median(sv[band]) / np.median(model[band])
bkg = lambda im: np.median(im[(np.abs(b) > 30) & (np.abs(b) < 60)])
args = list(map(float, sys.argv[3:]))
for i in range(0, len(args), 3):
    l0, b0, r0 = args[i:i + 3]
    dl = (lon[None, :] - ((l0 + 180) % 360 - 180) + 180) % 360 - 180
    d = np.hypot(dl * np.cos(np.radians(b0)), b[:, None] - b0)
    m = d < r0
    print("l %.1f b %.1f r %.1f: survey %.4f (peak %.4f)  model %.4f (peak %.4f)  sky around: survey %.4f model %.4f  -> model/survey %.2f" % (
        l0, b0, r0, sv[m].mean(), np.percentile(sv[m], 99), model[m].mean(), np.percentile(model[m], 99), bkg(sv), bkg(model),
        (model[m].mean() - bkg(model)) / max(sv[m].mean() - bkg(sv), 1e-9)))
