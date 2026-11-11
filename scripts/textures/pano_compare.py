#!/usr/bin/env python3
"""Side by side: the model's sky from Sol (scripts/gpano.mjs, raw float32 RGBA rows bottom-up) and the NASA SVS survey
(Deep Star Maps 2020 Milky Way layer, linear EXR), same projection, same tone curve, plus profiles across and along the band.

    .texvenv/bin/python -I scripts/textures/pano_compare.py <model.f32> <milkyway_gal.exr> <out.png> [--gain G] [--scale S]
    (survey "-": the model alone, e.g. a sky from elsewhere)

The model is scaled so that its median brightness over |b| < 30 deg matches the survey's (printed: the factor
the model is off by); --scale fixes the factor instead. Rows: survey, model, log ratio (red: model brighter).
"""
import argparse
import os

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


def srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 1e-12), 1 / 2.4) - 0.055)


def tone(x, gain):
    return np.clip(srgb(1.0 - np.exp(-gain * np.maximum(x, 0))) * 255 + 0.5, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model"); ap.add_argument("survey"); ap.add_argument("out")
    ap.add_argument("--gain", type=float, default=2.0)
    ap.add_argument("--scale", type=float)
    ap.add_argument("--crop", type=float, nargs=3, metavar=("L0", "HALF_L", "HALF_B"),
                    help="only survey and model, around longitude L0 within +-HALF_L, +-HALF_B (degrees)")
    a = ap.parse_args()
    raw = np.fromfile(a.model, dtype=np.float32)
    w = int(round(np.sqrt(raw.size / 2)))
    h = w // 2
    model = raw.reshape(h, w, 4)[::-1, :, :3]
    if a.survey == "-":  # the model alone (a sky from anywhere): scaled by --scale, else to a fixed median
        k = a.scale if a.scale else 0.01 / max(float(np.median(model)), 1e-12)
        Image.fromarray(tone(model * k, a.gain), "RGB").save(a.out)
        print(a.out, "x %.3g" % k)
        return
    sv = cv2.imread(a.survey, cv2.IMREAD_UNCHANGED)
    if sv is None:
        raise SystemExit("cannot read " + a.survey)
    sv = cv2.resize(sv[..., :3][..., ::-1].astype(np.float32), (w, h), interpolation=cv2.INTER_AREA)
    b = (0.5 - (np.arange(h) + 0.5) / h) * 180
    band = np.abs(b) < 30
    ms, mm = np.median(sv[band].mean(axis=1)), np.median(model[band].mean(axis=1))
    k = a.scale if a.scale else ms / max(mm, 1e-12)
    print("survey median %.4g model median %.4g -> model x %.3g" % (ms, mm, k))
    model = model * k
    # Profiles: mean over longitude (|l| < 60) against latitude, and over |b| < 5 against longitude.
    lat = lambda im: im[:, int(w * (0.5 - 60 / 360)):int(w * (0.5 + 60 / 360))].mean(axis=(1, 2))
    lon = lambda im: im[(np.abs(b) < 5)].mean(axis=(0, 2))
    for name, im in (("survey", sv), ("model", model)):
        pl, pn = lat(im), lon(im)
        print(name, "b=0/5/10/20/40 deg:", ["%.3g" % pl[np.argmin(np.abs(b - v))] for v in (0, 5, 10, 20, 40)],
              " l=0/30/90/180/270/330:", ["%.3g" % pn[int((0.5 - (v if v <= 180 else v - 360) / 360) * w) % w] for v in (0, 30, 90, 180, 270, 330)],
              " colour b/r %.3f" % (im[band][:, 2].mean() / max(im[band][:, 0].mean(), 1e-9)))
    if a.crop:
        l0, hl, hb = a.crop
        cx = (0.5 - ((l0 + 180) % 360 - 180) / 360) * w
        xs = (np.arange(int(2 * hl / 360 * w)) + cx - hl / 360 * w).astype(int) % w
        y0, y1 = int((0.5 - hb / 180) * h), int((0.5 + hb / 180) * h)
        rows = [tone(sv, a.gain)[y0:y1][:, xs], tone(model, a.gain)[y0:y1][:, xs]]
        Image.fromarray(np.concatenate(rows, axis=0), "RGB").save(a.out)
        print(a.out)
        return
    # Structure in the band (|b| < 20 deg), in log brightness: how much of it at fine (< 1 deg), mid (1-4 deg) and
    # coarse (4-16 deg) scales, and how well model and survey agree at each (correlation).
    ppd = w / 360.0
    rows = np.abs(b) < 20
    lg = lambda im: np.log(im.mean(axis=2) + 0.02 * ms)
    def bands(im):
        L = lg(im)
        blur = lambda x, deg: cv2.GaussianBlur(x, (0, 0), max(deg * ppd, 0.5))
        b0, b1, b4, b16 = L, blur(L, 0.5), blur(L, 2.0), blur(L, 8.0)
        return [(x - y)[rows] for x, y in ((b0, b1), (b1, b4), (b4, b16))]
    bs, bm = bands(sv), bands(model)
    names = ("fine <1 deg", "mid 1-4 deg", "coarse 4-16 deg")
    for n, x, y in zip(names, bs, bm):
        print("%-16s rms survey %.3f model %.3f  correlation %.2f" % (n, x.std(), y.std(), np.corrcoef(x.ravel(), y.ravel())[0, 1]))
    ratio = np.log2((model.mean(axis=2) + 0.01 * ms) / (sv.mean(axis=2) + 0.01 * ms))
    diff = np.zeros((h, w, 3), np.uint8)
    diff[..., 0] = np.clip(ratio, 0, 3) / 3 * 255
    diff[..., 2] = np.clip(-ratio, 0, 3) / 3 * 255
    sheet = np.concatenate([tone(sv, a.gain), tone(model, a.gain), diff], axis=0)
    im = Image.fromarray(sheet, "RGB")
    d = ImageDraw.Draw(im)
    for i, t in enumerate(("survey (NASA SVS)", "model x %.3g" % k, "log2 model/survey (red: model brighter)")):
        d.text((8, i * h + 6), t, fill=(255, 255, 0))
    for i in range(3):  # longitude ticks every 30 deg
        for l in range(-180, 181, 30):
            x = int((0.5 - l / 360) * (w - 1))
            d.line([(x, i * h + h - 8), (x, i * h + h)], fill=(120, 120, 120))
            d.text((x + 2, i * h + h - 18), str(l % 360), fill=(150, 150, 150))
    im.save(a.out)
    print(a.out, im.size)


if __name__ == "__main__":
    main()
