#!/usr/bin/env python3
"""How evenly the sky moves in a recorded flight (scripts/grecord.mjs frames): per frame, the mean absolute
change from the previous frame (stars masked out by a median filter), and a strip of every 6th frame.

    .texvenv/bin/python -I scripts/textures/motion.py <dir> [<strip.png>]

Even motion: changes of similar size every frame. Stepping: most frames near zero with occasional jumps
(reported as the ratio of the largest change to the median, and the share of near-still frames).
"""
import glob
import sys

import os

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "0")
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageFilter

files = sorted(glob.glob(sys.argv[1] + "/f*.jpg"))
frames = [np.asarray(Image.open(f).convert("L").filter(ImageFilter.MedianFilter(5)).resize((250, 143)), np.float32) for f in files]
times = [float(f.rsplit("_", 1)[1][:-4]) for f in files]
d = np.array([np.abs(b - a).mean() for a, b in zip(frames, frames[1:])])
dt = np.diff(times) * 1000
med = float(np.median(d))
print("frames %d  frame interval ms: median %.1f max %.1f" % (len(files), np.median(dt), dt.max()))
print("change per frame: median %.3f  max %.3f  max/median %.1f  near-still frames (< 0.3 median) %d%%" % (
    med, d.max(), d.max() / max(med, 1e-6), 100 * np.mean(d < 0.3 * med)))
# Where the sky moved: the shift of the middle of the frame from one frame to the next (phase correlation).
win = cv2.createHanningWindow((160, 90), cv2.CV_32F)
mid = lambda im: np.ascontiguousarray(im[26:116, 45:205])
shift = np.array([np.hypot(*cv2.phaseCorrelate(mid(a), mid(b), win)[0]) for a, b in zip(frames, frames[1:])]) * 4  # in px of the 1000 px frame
ms = float(np.median(shift))
print("image shift per frame (px): median %.2f  p10 %.2f  p90 %.2f  max %.2f  max/median %.1f" % (
    ms, np.percentile(shift, 10), np.percentile(shift, 90), shift.max(), shift.max() / max(ms, 1e-6)))
print("shift series:", " ".join("%.1f" % v for v in shift))
print("series:", " ".join("%.2f" % v for v in d))
if len(sys.argv) > 2:
    picks = [Image.open(f).convert("RGB").resize((250, 143)) for f in files[::6]]
    s = Image.new("RGB", (250 * len(picks), 143))
    for i, im in enumerate(picks):
        s.paste(im, (250 * i, 0))
    s.save(sys.argv[2])
