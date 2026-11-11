#!/usr/bin/env python3
"""Texture conversion helpers for the space-engine asset pipeline.

Run with the project venv, isolated mode, from outside the raw download dir:
    .texvenv/bin/python -I scripts/textures/textool.py <command> ...

Commands
  info    <src>                                   print size/mode/stats
  jpg     <src> <dst> <w> <h> [--roll] [--gray] [--quality Q] [--stretch]
  preview <dst> <w> <src> [<src> ...] [--roll]    stacked preview (first frame of each)
  height-nc   <dst.png> <w> <h> <band0.nc> ...    ETOPO NetCDF-3 bands (lat ascending, lon 0..360)
  height-tif  <dst.png> <w> <h> <src.tif> --scale S [--roll]   float/int TIFF * S = metres
  height-img  <dst.png> <w> <h> <src.img> --cols C --rows R [--roll]  raw big-endian int16 (PDS MEGDR)
  decode-height <src.png> <min> <max> <dst.jpg> <w>   shaded-relief preview from an encoded height PNG

Height encoding: v = round((h-min)/(max-min)*65535); R = v>>8; G = v&255; B = 0.
The min/max actually used are printed as JSON on the last stdout line.
"""
import argparse
import json
import math
import struct
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the planetary mosaics are legitimately huge


def load_rgb(path):
    """Load any image as a PIL image (8-bit). Falls back to tifffile for odd TIFFs."""
    try:
        im = Image.open(path)
        im.load()
        if im.mode in ("I;16", "I;16B", "I;16L", "I"):
            a = np.asarray(im).astype(np.float32)
            a = a / (65535.0 if a.max() > 255 else 255.0) * 255.0
            im = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "L")
        elif im.mode == "F":
            a = np.asarray(im)
            a = (a - a.min()) / max(1e-9, float(a.max() - a.min())) * 255.0
            im = Image.fromarray(a.astype(np.uint8), "L")
        return im
    except Exception as e:  # noqa: BLE001
        import tifffile

        a = tifffile.imread(path)
        if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[2] not in (3, 4):
            a = np.moveaxis(a, 0, 2)
        if a.dtype == np.uint16:
            a = (a.astype(np.float32) / 257.0 + 0.5).astype(np.uint8)
        elif a.dtype != np.uint8:
            a = a.astype(np.float32)
            a = ((a - a.min()) / max(1e-9, float(a.max() - a.min())) * 255.0).astype(np.uint8)
        if a.ndim == 3 and a.shape[2] > 3:
            a = a[:, :, :3]
        return Image.fromarray(a)


def roll_half(im):
    a = np.asarray(im)
    return Image.fromarray(np.roll(a, a.shape[1] // 2, axis=1))


def fill_nodata(a, thr):
    """Fill no-data (near-black) regions of an equirectangular uint8 image with a smooth
    extrapolation of the surrounding valid pixels (multi-scale normalised convolution, wrapping
    in longitude). Returns (filled uint8 array, fraction of pixels that were synthesised)."""
    import cv2

    squeeze = a.ndim == 2
    if squeeze:
        a = a[..., None]
    f = a.astype(np.float32)
    h, w = f.shape[:2]
    valid = (f.max(axis=2) > thr).astype(np.float32)
    valid = cv2.erode(valid, np.ones((7, 7), np.uint8))
    frac = 1.0 - float(valid.mean())
    result = np.empty_like(f)
    result[:] = (f * valid[..., None]).sum(axis=(0, 1)) / max(1.0, float(valid.sum()))
    for s in (256, 96, 32, 10, 3):  # coarse -> fine
        k = max(1, s // 3)
        sw, sh = max(8, w // k), max(4, h // k)
        num = cv2.resize(f * valid[..., None], (sw, sh), interpolation=cv2.INTER_AREA)
        den = cv2.resize(valid, (sw, sh), interpolation=cv2.INTER_AREA)
        if num.ndim == 2:
            num = num[..., None]
        pad = min(sw, 12)
        num = cv2.copyMakeBorder(num, 0, 0, pad, pad, cv2.BORDER_WRAP)
        den = cv2.copyMakeBorder(den, 0, 0, pad, pad, cv2.BORDER_WRAP)
        num = cv2.GaussianBlur(num, (0, 0), 3.0)
        den = cv2.GaussianBlur(den, (0, 0), 3.0)
        if num.ndim == 2:
            num = num[..., None]
        num, den = num[:, pad:-pad], den[:, pad:-pad]
        est = cv2.resize(num / np.maximum(den, 1e-4)[..., None], (w, h), interpolation=cv2.INTER_CUBIC)
        conf = cv2.resize(np.clip(den / 0.05, 0, 1), (w, h), interpolation=cv2.INTER_LINEAR)
        if est.ndim == 2:
            est = est[..., None]
        result = result * (1 - conf[..., None]) + est * conf[..., None]
    soft = cv2.GaussianBlur(valid, (0, 0), 2.5)
    soft = np.clip((soft - 0.5) * 2.0, 0, 1)[..., None]  # 1 well inside valid data, 0 at its edge
    out = np.clip(f * soft + result * (1 - soft) + 0.5, 0, 255).astype(np.uint8)
    return (out[..., 0] if squeeze else out), frac


def cmd_info(args):
    im = Image.open(args.src)
    print(im.format, im.mode, im.size, im.info.get("compression"))
    try:
        a = np.asarray(im)
        print("dtype", a.dtype, "min", a.min(), "max", a.max(), "mean", float(a.mean()))
    except Exception as e:  # noqa: BLE001
        print("stats failed", e)


def cmd_jpg(args):
    im = load_rgb(args.src)
    if args.roll:
        im = roll_half(im)
    if args.gray:
        im = im.convert("L")
    elif im.mode != "RGB":
        im = im.convert("RGB")
    if args.stretch:
        a = np.asarray(im).astype(np.float32)
        lo, hi = np.percentile(a[a > 0] if (a > 0).any() else a, [0.5, 99.8])
        a = np.clip((a - lo) / max(1.0, hi - lo), 0, 1) * 255.0
        im = Image.fromarray((a + 0.5).astype(np.uint8), im.mode)
    if im.size != (args.w, args.h):
        im = im.resize((args.w, args.h), Image.LANCZOS)
    if args.fill is not None:
        arr, frac = fill_nodata(np.asarray(im), args.fill)
        im = Image.fromarray(arr, im.mode)
        print("filled no-data fraction: %.3f" % frac)
    im.save(args.dst, "JPEG", quality=args.quality, optimize=True, progressive=True, subsampling=args.subsampling)
    print(args.dst, im.size, im.mode)


def cmd_preview(args):
    tiles = []
    for s in args.src:
        im = load_rgb(s).convert("RGB")
        if args.roll:
            im = roll_half(im)
        h = max(1, round(im.size[1] * args.w / im.size[0]))
        tiles.append(im.resize((args.w, h), Image.BILINEAR))
    out = Image.new("RGB", (args.w, sum(t.size[1] for t in tiles)))
    y = 0
    for t in tiles:
        out.paste(t, (0, y))
        y += t.size[1]
    out.save(args.dst, "JPEG", quality=80)
    print(args.dst, out.size)


# ---------------------------------------------------------------- heights
def area_resize(a, w, h):
    """Area-average a float32 2D array to (h, w). Integer BOX pre-reduction, then LANCZOS."""
    im = Image.fromarray(a.astype(np.float32), "F")
    return np.asarray(im.resize((w, h), Image.BOX if (a.shape[1] / w) >= 2 else Image.LANCZOS), dtype=np.float32)


def encode_height(a, dst, hmin=None, hmax=None):
    lo = float(math.floor(a.min())) if hmin is None else hmin
    hi = float(math.ceil(a.max())) if hmax is None else hmax
    v = np.clip(np.rint((a - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    rgb = np.zeros(a.shape + (3,), np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 255
    Image.fromarray(rgb, "RGB").save(dst, "PNG", optimize=True)
    print(json.dumps({"file": dst, "width": a.shape[1], "height": a.shape[0], "minMeters": lo, "maxMeters": hi,
                      "dataMin": float(a.min()), "dataMax": float(a.max()), "bits": 16}))


def read_nc3_var(path, name):
    """Minimal NetCDF-3 (classic / 64-bit offset) reader for one non-record variable."""
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic[:3] != b"CDF":
            raise ValueError("not a NetCDF-3 file: %r" % magic)
        off64 = magic[3] == 2
        pos = [4]

        def rd(fmt):
            n = struct.calcsize(fmt)
            f.seek(pos[0])
            v = struct.unpack(fmt, f.read(n))
            pos[0] += n
            return v

        def rname():
            (n,) = rd(">i")
            f.seek(pos[0])
            s = f.read(n).decode("utf8", "replace")
            pos[0] += (n + 3) // 4 * 4
            return s

        tsize = {1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8}

        def skip_atts():
            tag, n = rd(">ii")
            for _ in range(n):
                rname()
                t, cnt = rd(">ii")
                pos[0] += (cnt * tsize[t] + 3) // 4 * 4

        rd(">i")  # numrecs
        tag, ndims = rd(">ii")
        dims = []
        for _ in range(ndims):
            dn = rname()
            (dl,) = rd(">i")
            dims.append((dn, dl))
        skip_atts()
        tag, nvars = rd(">ii")
        found = None
        for _ in range(nvars):
            vn = rname()
            (nd,) = rd(">i")
            dimids = rd(">%di" % nd) if nd else ()
            skip_atts()
            t, vsize = rd(">ii")
            (begin,) = rd(">q" if off64 else ">i")
            if vn == name:
                found = (t, [dims[i][1] for i in dimids], begin)
        if not found:
            raise KeyError(name)
        t, shape, begin = found
        dt = {3: ">i2", 4: ">i4", 5: ">f4", 6: ">f8", 1: "i1"}[t]
        return np.memmap(path, dtype=dt, mode="r", offset=begin, shape=tuple(shape))


def cmd_height_nc(args):
    bands = []
    for p in args.src:
        z = read_nc3_var(p, args.var)
        lat = read_nc3_var(p, "latitude")
        print(p, z.shape, "lat", float(lat[0]), "..", float(lat[-1]), file=sys.stderr)
        bands.append((float(lat[0]), np.asarray(z, dtype=np.float32)))
    bands.sort(key=lambda b: b[0])
    a = np.concatenate([b[1] for b in bands], axis=0)  # south -> north
    a = a[::-1]  # north up
    if (a < -20000).any():
        raise ValueError("fill values present")
    a = np.roll(a, a.shape[1] // 2, axis=1)  # 0..360 -> -180..180
    print("full-res range", float(a.min()), float(a.max()), a.shape, file=sys.stderr)
    encode_height(area_resize(a, args.w, args.h), args.dst)


def cmd_height_tif(args):
    import tifffile

    a = tifffile.imread(args.src).astype(np.float32) * args.scale
    print("src", a.shape, float(a.min()), float(a.max()), file=sys.stderr)
    if args.roll:
        a = np.roll(a, a.shape[1] // 2, axis=1)
    encode_height(area_resize(a, args.w, args.h), args.dst)


def cmd_height_img(args):
    a = np.fromfile(args.src, dtype=">i2").reshape(args.rows, args.cols).astype(np.float32)
    print("src", a.shape, float(a.min()), float(a.max()), file=sys.stderr)
    if args.roll:
        a = np.roll(a, a.shape[1] // 2, axis=1)
    encode_height(area_resize(a, args.w, args.h), args.dst)


def cmd_decode_height(args):
    im = np.asarray(Image.open(args.src).convert("RGB")).astype(np.float32)
    v = im[..., 0] * 256.0 + im[..., 1]
    hgt = args.min + v / 65535.0 * (args.max - args.min)
    step = max(1, hgt.shape[1] // args.w)
    hs = hgt[::step, ::step]
    gx = np.gradient(hs, axis=1)
    k = 8.0 / max(1e-6, float(np.percentile(np.abs(gx), 99)))
    shade = np.clip(0.5 - gx * k * 0.06, 0, 1)
    n = (hs - hs.min()) / (hs.max() - hs.min())
    rgb = np.stack([n * 0.9 + 0.1, 0.25 + n * 0.6, 0.6 - n * 0.4], -1)
    if args.sea is not None:
        sea = hs < args.sea
        rgb[sea] = np.stack([n[sea] * 0.2, n[sea] * 0.5, 0.3 + n[sea] * 0.9], -1)
    out = np.clip(rgb * (0.4 + 1.2 * shade[..., None]), 0, 1)
    Image.fromarray((out * 255).astype(np.uint8)).save(args.dst, "JPEG", quality=82)
    print(args.dst, out.shape, "decoded range", float(hgt.min()), float(hgt.max()))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("info"); p.add_argument("src"); p.set_defaults(fn=cmd_info)
    p = sub.add_parser("jpg")
    p.add_argument("src"); p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("h", type=int)
    p.add_argument("--roll", action="store_true"); p.add_argument("--gray", action="store_true")
    p.add_argument("--stretch", action="store_true")
    p.add_argument("--fill", type=float, default=None, help="fill no-data pixels (max channel <= FILL) with smooth extrapolation")
    p.add_argument("--quality", type=int, default=87); p.add_argument("--subsampling", type=int, default=2)
    p.set_defaults(fn=cmd_jpg)
    p = sub.add_parser("preview")
    p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("src", nargs="+")
    p.add_argument("--roll", action="store_true"); p.set_defaults(fn=cmd_preview)
    p = sub.add_parser("height-nc")
    p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("h", type=int); p.add_argument("src", nargs="+")
    p.add_argument("--var", default="z"); p.set_defaults(fn=cmd_height_nc)
    p = sub.add_parser("height-tif")
    p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("h", type=int); p.add_argument("src")
    p.add_argument("--scale", type=float, default=1.0); p.add_argument("--roll", action="store_true")
    p.set_defaults(fn=cmd_height_tif)
    p = sub.add_parser("height-img")
    p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("h", type=int); p.add_argument("src")
    p.add_argument("--cols", type=int, required=True); p.add_argument("--rows", type=int, required=True)
    p.add_argument("--roll", action="store_true"); p.set_defaults(fn=cmd_height_img)
    p = sub.add_parser("decode-height")
    p.add_argument("src"); p.add_argument("min", type=float); p.add_argument("max", type=float)
    p.add_argument("dst"); p.add_argument("w", type=int); p.add_argument("--sea", type=float, default=None)
    p.set_defaults(fn=cmd_decode_height)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
