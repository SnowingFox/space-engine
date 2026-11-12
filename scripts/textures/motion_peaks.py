#!/usr/bin/env python3
"""The frames of a recorded flight (scripts/grecord.mjs) where the image changed most, with the time and the
mean brightness before and after: where to look for a jump.  .texvenv/bin/python -I scripts/textures/motion_peaks.py <dir> [n 10]"""
import glob
import sys

import numpy as np
from PIL import Image, ImageFilter

files = sorted(glob.glob(sys.argv[1] + "/f*.jpg"))
fr = [np.asarray(Image.open(f).convert("L").filter(ImageFilter.MedianFilter(5)).resize((250, 143)), np.float32) for f in files]
ts = [float(f.rsplit("_", 1)[1][:-4]) for f in files]
d = np.array([np.abs(b - a).mean() for a, b in zip(fr, fr[1:])])
med = np.median(d)
for i in sorted(np.argsort(d)[::-1][: int(sys.argv[2]) if len(sys.argv) > 2 else 10]):
    print("frame %3d  t %.2f s  change %.2f (%.0fx median)  brightness %.1f -> %.1f" % (i + 1, ts[i + 1] - ts[0], d[i], d[i] / med, fr[i].mean(), fr[i + 1].mean()))
