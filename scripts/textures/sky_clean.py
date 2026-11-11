#!/usr/bin/env python3
"""Denoise and tone-map the NASA SVS Deep Star Maps 2020 Milky Way layer (linear float EXR) to an 8-bit sRGB JPEG.

    .texvenv/bin/python -I scripts/textures/sky_clean.py <milkyway_gal.exr> <dst.jpg> [--crop x y w h]

The source is built from star counts, so its faint parts carry per-pixel shot noise. The noise is removed
with an edge-preserving filter in log space (dust lanes keep their edges), the sky background is taken
down to black, and the band gets a filmic curve.
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
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--crop", type=int, nargs=4)
    ap.add_argument("--gain", type=float, default=3.0)
    ap.add_argument("--black", type=float, default=0.004)
    ap.add_argument("--gamma", type=float, default=1.12)
    ap.add_argument("--nlm", type=float, default=0.2)
    ap.add_argument("--sigma", type=float, default=0.2)
    ap.add_argument("--sat", type=float, default=1.15)
    ap.add_argument("--quality", type=int, default=90)
    a = ap.parse_args()
    img = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit("cannot read " + a.src)
    img = img[..., :3][..., ::-1].astype(np.float32)
    print("linear percentiles", [float(np.percentile(img, p)) for p in (1, 10, 50, 90, 99, 99.9)])
    if a.crop:
        x, y, w, h = a.crop
        img = np.ascontiguousarray(img[y:y + h, x:x + w])
    # Edge-preserving smoothing of the brightness in log space; colour is smoothed more, it has no fine detail.
    lum = img.max(axis=2)
    log = np.log(np.maximum(lum, 1e-5))
    if a.nlm > 0:
        # Non-local means keeps thin filaments that a local filter would smear.
        lo, hi = np.log(1e-4), np.log(1.0)
        q = np.clip((log - lo) / (hi - lo), 0, 1)
        q16 = (q * 65535).astype(np.uint16)
        d16 = cv2.fastNlMeansDenoising(q16, [a.nlm * 65535 / (hi - lo)], None, 5, 15, cv2.NORM_L1)
        den = d16.astype(np.float32) / 65535 * (hi - lo) + lo
        # A little of the original grain back: perfectly smooth reads as painted.
        den = den + 0.25 * (np.maximum(log, lo) - den)
    else:
        den = cv2.bilateralFilter(log, d=7, sigmaColor=a.sigma, sigmaSpace=2.0)
    lum2 = np.exp(den)
    chroma = img / np.maximum(lum[..., None], 1e-5)
    chroma = cv2.GaussianBlur(chroma, (0, 0), 2.5)
    grey = chroma.mean(axis=2, keepdims=True)
    chroma = np.maximum(grey + (chroma - grey) * a.sat, 0.0)
    x = np.maximum(lum2 - a.black, 0.0)
    y = 1.0 - np.exp(-a.gain * np.power(x, a.gamma))
    out = chroma / np.maximum(chroma.max(axis=2, keepdims=True), 1e-5) * y[..., None]
    out = np.clip(srgb_oetf(out) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out, "RGB").save(a.dst, "JPEG", quality=a.quality, optimize=True, progressive=True, subsampling=0)
    print(a.dst, out.shape, "mean", float(out.mean()), "p50", float(np.percentile(out, 50)), "p99", float(np.percentile(out, 99)))


if __name__ == "__main__":
    main()
