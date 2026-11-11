#!/usr/bin/env python3
"""Galaxy sprite helpers.

  sheet  <dst.jpg> <src> [<src> ...]         labelled contact sheet (also verifies each file decodes fully)
  sprite <src> <dst.jpg> --cx X --cy Y --r R [--size 1024] [--bg auto|N] [--inner 0.72] [--gain G] [--rot DEG]

sprite: crops a square of half-size R (fractions of the source's SHORT side; cx, cy are fractions of
width/height), padding with black if the square leaves the frame, subtracts the sky background
(median of the border ring unless --bg is given), and multiplies by a radial window that is 1 inside
`inner` (fraction of half-size) and falls smoothly to 0 at the edge, so corners are pure black and
the result can be drawn as an additive sprite.
"""
import argparse
import sys

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def cmd_sheet(a):
    cell, cols = 350, 4
    rows = (len(a.src) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), (40, 0, 40))
    for i, f in enumerate(a.src):
        x, y = (i % cols) * cell, (i // cols) * cell
        try:
            im = Image.open(f).convert("RGB")
        except Exception as e:  # noqa: BLE001
            print("BAD", f, e)
            continue
        label = "%s %dx%d" % (f.split("/")[-1], im.size[0], im.size[1])
        im.thumbnail((cell - 4, cell - 4))
        sheet.paste(im, (x + 2, y + 2))
        ImageDraw.Draw(sheet).text((x + 6, y + 6), label, fill=(255, 255, 0))
    sheet.save(a.dst, quality=80)
    print(a.dst, sheet.size)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def cmd_sprite(a):
    im = Image.open(a.src).convert("RGB")
    W, H = im.size
    short = min(W, H)
    r = a.r * short
    cx, cy = a.cx * W, a.cy * H
    box = (int(round(cx - r)), int(round(cy - r)), int(round(cx + r)), int(round(cy + r)))
    crop = im.crop(box)  # PIL pads out-of-frame areas with black
    if a.rot:
        crop = crop.rotate(a.rot, resample=Image.BICUBIC)
    crop = crop.resize((a.size, a.size), Image.LANCZOS)
    arr = np.asarray(crop).astype(np.float32)
    n = a.size
    yy, xx = np.mgrid[0:n, 0:n]
    rad = np.hypot((xx - (n - 1) / 2) / (n / 2), (yy - (n - 1) / 2) / (n / 2))
    if a.bg == "auto":
        ring = (rad > 0.9) & (rad < 1.0) & (arr.sum(axis=2) > 6)  # ignore padded black
        bg = np.percentile(arr[ring], 35, axis=0) if ring.sum() > 500 else np.zeros(3, np.float32)
    else:
        bg = np.full(3, float(a.bg), np.float32)
    arr = np.clip(arr - bg, 0, None)
    arr *= a.gain * 255.0 / max(1.0, 255.0 - float(bg.max()))
    win = 1.0 - smoothstep(a.inner, 0.985, rad)
    if a.ay < 1.0:  # extra elliptical window (flattened vertically) for strip-shaped sources
        erad = np.hypot((xx - (n - 1) / 2) / (n / 2), (yy - (n - 1) / 2) / (n / 2) / a.ay)
        win = win * (1.0 - smoothstep(a.inner, 0.985, erad))
    arr = np.clip(arr * win[..., None], 0, 255)
    out = Image.fromarray((arr + 0.5).astype(np.uint8), "RGB")
    out.save(a.dst, "JPEG", quality=a.quality, optimize=True, progressive=True)
    corners = [arr[:24, :24].max(), arr[:24, -24:].max(), arr[-24:, :24].max(), arr[-24:, -24:].max()]
    print(a.dst, out.size, "bg", [round(float(b), 1) for b in bg], "corner max", [int(c) for c in corners],
          "mean", round(float(arr.mean()), 1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("sheet"); p.add_argument("dst"); p.add_argument("src", nargs="+"); p.set_defaults(fn=cmd_sheet)
    p = sub.add_parser("sprite")
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--cx", type=float, default=0.5); p.add_argument("--cy", type=float, default=0.5)
    p.add_argument("--r", type=float, default=0.5); p.add_argument("--size", type=int, default=1024)
    p.add_argument("--bg", default="auto"); p.add_argument("--inner", type=float, default=0.72)
    p.add_argument("--gain", type=float, default=1.0); p.add_argument("--rot", type=float, default=0.0)
    p.add_argument("--quality", type=int, default=88)
    p.add_argument("--ay", type=float, default=1.0, help="vertical flattening of an extra elliptical window")
    p.set_defaults(fn=cmd_sprite)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
