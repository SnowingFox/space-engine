"""Pixel difference between screenshots: .texvenv/bin/python -I scripts/imgdiff.py a.png b.png [heat.png]

Prints the mean and 99.9th-percentile absolute difference (0..255, max over RGB) and the share of
pixels that differ by more than 2, 4 and 8 levels. With a third path, writes a heat map of the
difference (amplified 8x).
"""
import sys

import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
d = np.abs(a - b).max(axis=2)
print(f'mean {d.mean():.3f}  p99.9 {np.percentile(d, 99.9):.0f}  max {d.max()}  '
      f'>2 {(d > 2).mean():.4f}  >4 {(d > 4).mean():.4f}  >8 {(d > 8).mean():.4f}')
if len(sys.argv) > 3:
    Image.fromarray(np.clip(d * 8, 0, 255).astype(np.uint8)).save(sys.argv[3])
