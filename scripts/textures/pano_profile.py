#!/usr/bin/env python3
"""Latitude profiles of the model's sky (scripts/gpano.mjs output) and the survey, in a few longitude strips.

    .texvenv/bin/python -I scripts/textures/pano_profile.py <model.f32> <milkyway_gal.exr> [--scale S]

Prints mean brightness in |l - L| < 10 deg against b, for L = 0, 30, 90, 180, 270, 330; the model scaled like
pano_compare.py (median over |b| < 30 matched) unless --scale is given.
"""
import argparse
import os

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model"); ap.add_argument("survey"); ap.add_argument("--scale", type=float)
    a = ap.parse_args()
    raw = np.fromfile(a.model, dtype=np.float32)
    w = int(round(np.sqrt(raw.size / 2))); h = w // 2
    model = raw.reshape(h, w, 4)[::-1, :, :3].mean(axis=2)
    sv = cv2.imread(a.survey, cv2.IMREAD_UNCHANGED)
    sv = cv2.resize(sv[..., :3].astype(np.float32), (w, h), interpolation=cv2.INTER_AREA).mean(axis=2)
    b = (0.5 - (np.arange(h) + 0.5) / h) * 180
    lon = (0.5 - (np.arange(w) + 0.5) / w) * 360
    band = np.abs(b) < 30
    k = a.scale or np.median(sv[band]) / np.median(model[band])
    model = model * k
    bs = [-30, -15, -8, -4, -2, 0, 2, 4, 8, 15, 30]
    print("model x %.3g    b:" % k, " ".join("%6d" % v for v in bs))
    for L in (0, 30, 90, 180, 270, 330):
        d = (lon - ((L + 180) % 360 - 180) + 180) % 360 - 180
        cols = np.abs(d) < 10
        for name, im in (("survey", sv), ("model ", model)):
            prof = im[:, cols].mean(axis=1)
            print("l=%3d %s" % (L, name), " ".join("%6.2f" % (100 * prof[np.argmin(np.abs(b - v))]) for v in bs))


if __name__ == "__main__":
    main()
