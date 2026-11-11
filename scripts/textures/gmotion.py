#!/usr/bin/env python3
"""Analysis of scripts/gmotion.mjs recordings: per scenario, the frame-to-frame image change (mean absolute
difference, stars masked out by a median filter), still frames while the camera moves, brightness pulses,
frame times and, where the galaxy is drawn from a viewpoint other than the camera's, how far behind it is.

    .texvenv/bin/python -I scripts/textures/gmotion.py <dir>
"""
import glob
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageFilter

root = sys.argv[1]
print("scenario | change/frame median | p99 | max/median | still frames | shift px/frame median | jerk median, p95 (x shift) | stalls | flow twitch median, p95 | grain % | boil % | brightness pulses (max %) | frame ms median | max | >25 ms | long tasks | lag ly (median, max)")
for sc in sorted(os.listdir(root)):
    d0 = os.path.join(root, sc)
    files = sorted(glob.glob(d0 + "/f*.jpg"))
    if len(files) < 10:
        continue
    # (The first frames come before the flight has started: the recording starts with it, but its frames lag.)
    fr2 = [np.asarray(Image.open(f).convert("L").filter(ImageFilter.MedianFilter(5)), np.float32) for f in files]
    fr = [cv2.resize(f, (250, 143), interpolation=cv2.INTER_AREA) for f in fr2]
    d = np.array([np.abs(b - a).mean() for a, b in zip(fr, fr[1:])])[3:]
    med = float(np.median(d))
    moving = sc != "rest"
    still = int(np.sum(d < 0.3 * med)) if moving else 0
    # Brightness pulses: a frame brighter or darker than both neighbours' mean (a steady change is no pulse).
    lum = np.array([f.mean() for f in fr])[3:]
    dev = lum[1:-1] - 0.5 * (lum[:-2] + lum[2:])
    res = dev / np.maximum(lum[1:-1], 1.0)
    pulses = int(np.sum((np.abs(res) > 0.006) & (np.abs(dev) > 0.25)))
    # Jerk: how much the image's frame-to-frame shift (phase correlation of the middle) changes from one frame
    # to the next, relative to the shift itself. Smooth motion: small; stepping or twitching: near 1 or more.
    win = cv2.createHanningWindow((160, 90), cv2.CV_32F)
    mid = lambda im: np.ascontiguousarray(im[26:116, 45:205])
    # (Only where the correlation is clear: flying through clouds, near and far ones move apart.)
    pc = [cv2.phaseCorrelate(mid(a), mid(b), win) for a, b in zip(fr[3:], fr[4:])]
    sh = np.array([c[0] for c in pc]) * 4
    ok = np.array([c[1] > 0.3 for c in pc])
    mag = np.hypot(sh[:, 0], sh[:, 1])
    pair = ok[1:] & ok[:-1]
    jerk = np.hypot(*(sh[1:] - sh[:-1]).T)[pair] if pair.any() else np.zeros(1)
    ms = float(np.median(mag[ok])) if ok.any() else 0.0
    # Stalls: a frame whose shift is under a third of its neighbours' (the sky stood still, then caught up).
    stalls = 0
    for i in range(len(mag)):
        nb = [mag[j] for j in range(max(0, i - 3), min(len(mag), i + 4)) if j != i and ok[j]]
        if ok[i] and len(nb) >= 3 and np.median(nb) > 1.0 and mag[i] < np.median(nb) / 3:
            stalls += 1
    # Twitch, per pixel: dense optical flow between successive frames, and how much each pixel's flow changes
    # from one frame pair to the next (the dust moving in fits and starts), relative to the flow itself.
    # (Each layer of clouds is followed on its own: near ones sweep, far ones creep.)
    big = [cv2.resize(f, (500, 286), interpolation=cv2.INTER_AREA) for f in fr2[3:]]
    flows = [cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 21, 3, 5, 1.1, 0) for a, b in zip(big, big[1:])]
    tw = []
    for f0, f1 in zip(flows, flows[1:]):
        m = np.hypot(f1[..., 0], f1[..., 1])
        sel = m > 0.5
        if sel.sum() > 500:
            tw.append(float(np.median(np.hypot(*(f1 - f0)[sel].T)) / np.median(m[sel])))
    twitch = "%.2f, %.2f" % (np.median(tw), np.percentile(tw, 95)) if tw else "-"
    # Grain: fine noise in the glow and dust (not the stars), relative to its brightness, frame by frame.
    gr = []
    for f in files[6::4]:
        raw = np.asarray(Image.open(f).convert("L"), np.float32)
        med5 = cv2.medianBlur(raw.astype(np.uint8), 5).astype(np.float32)
        stars = cv2.dilate(((raw - med5) > 10).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        smooth = cv2.GaussianBlur(med5, (0, 0), 2.0)
        sel = (~stars) & (smooth > 12)
        if sel.sum() > 2000:
            gr.append(float(np.sqrt(np.mean((med5 - smooth)[sel] ** 2)) / np.mean(smooth[sel]) * 100))
    grain = "%.2f" % np.median(gr) if gr else "-"
    # Boil: what changes from one frame to the next once the motion is taken out (each frame warped onto the
    # next along the optical flow): grain that crawls or flickers, relative to the brightness; stars left out.
    bo = []
    for i in range(6, len(files) - 1, 4):
        a = np.asarray(Image.open(files[i]).convert("L"), np.float32)
        b = np.asarray(Image.open(files[i + 1]).convert("L"), np.float32)
        ma = cv2.medianBlur(a.astype(np.uint8), 5).astype(np.float32)
        mb = cv2.medianBlur(b.astype(np.uint8), 5).astype(np.float32)
        fl = cv2.calcOpticalFlowFarneback(cv2.GaussianBlur(mb, (0, 0), 2), cv2.GaussianBlur(ma, (0, 0), 2), None, 0.5, 4, 25, 3, 5, 1.1, 0)
        h, w = a.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        wa = cv2.remap(ma, gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR)
        stars = cv2.dilate((((a - ma) > 10) | ((b - mb) > 10)).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        sm = cv2.GaussianBlur(mb, (0, 0), 3)
        edge = 12
        sel = (~stars) & (sm > 12)
        sel[:edge] = sel[-edge:] = False
        sel[:, :edge] = sel[:, -edge:] = False
        d = mb - wa
        d = d - cv2.GaussianBlur(d, (0, 0), 3)
        if sel.sum() > 2000:
            bo.append(float(np.sqrt(np.mean(d[sel] ** 2)) / np.mean(sm[sel]) * 100))
    boil = "%.2f" % np.median(bo) if bo else "-"
    rec = json.load(open(os.path.join(d0, "rec.json")))
    t = np.array(rec["times"])
    dt = np.diff(t)[30:] if len(t) > 40 else np.diff(t)
    lag = "-"
    shown = rec.get("shown") or []
    cams = rec.get("cams") or []
    lags = [np.linalg.norm(np.array(s) - np.array(c)) for s, c in zip(shown, cams) if s]
    if lags:
        lag = "%.1f, %.1f" % (np.median(lags), np.max(lags))
    print("%s | %.3f | %.3f | %.1f | %d of %d | %.2f | %.2f, %.2f | %d | %s | %s | %s | %d (%.1f%%) | %.1f | %.1f | %d | %d | %s" % (
        sc, med, np.percentile(d, 99), d.max() / max(med, 1e-6), still, len(d), ms, np.median(jerk) / max(ms, 0.05), np.percentile(jerk, 95) / max(ms, 0.05), stalls, twitch, grain, boil, pulses, 100 * np.abs(res).max(),
        np.median(dt), dt.max(), int(np.sum(dt > 25)), rec["long"], lag))
