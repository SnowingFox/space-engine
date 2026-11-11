#!/usr/bin/env python3
"""Tone-map a linear float EXR all-sky map (NASA SVS Deep Star Maps 2020) to an 8-bit sRGB JPEG.

    OPENCV_IO_ENABLE_OPENEXR=1 .texvenv/bin/python -I scripts/textures/sky_tonemap.py \
        <src.exr> <dst.jpg> <w> <h> [--gain G] [--black B] [--quality Q]

Curve: y = 1 - exp(-gain * max(x - black, 0))  (linear near zero, soft shoulder), then the sRGB OETF.
No geometric change: the SVS "_gal" maps are plate carree in galactic coordinates, galactic centre in
the middle, north galactic pole up, galactic longitude increasing to the LEFT (sky seen from inside).
"""
import argparse
import os

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402


def srgb_oetf(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 1e-12), 1 / 2.4) - 0.055)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst"); ap.add_argument("w", type=int); ap.add_argument("h", type=int)
    ap.add_argument("--gain", type=float, default=2.0)
    ap.add_argument("--black", type=float, default=0.0)
    ap.add_argument("--quality", type=int, default=88)
    a = ap.parse_args()
    img = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit("cannot read " + a.src)
    img = img[..., :3][..., ::-1].astype(np.float32)  # BGR -> RGB
    if (img.shape[1], img.shape[0]) != (a.w, a.h):
        img = cv2.resize(img, (a.w, a.h), interpolation=cv2.INTER_AREA)
    y = 1.0 - np.exp(-a.gain * np.maximum(img - a.black, 0.0))
    out = np.clip(srgb_oetf(y) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out, "RGB").save(a.dst, "JPEG", quality=a.quality, optimize=True, progressive=True, subsampling=0)
    print(a.dst, out.shape, "mean", float(out.mean()), "p50", float(np.percentile(out, 50)), "p99", float(np.percentile(out, 99)), "max", int(out.max()))


if __name__ == "__main__":
    main()
