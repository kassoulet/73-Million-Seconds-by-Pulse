#!/usr/bin/env python3
"""python3 tools/cmp.py ours.png golden.png [out.png]  -> prints mean abs error / PSNR, writes ours|golden|diff*4 side by side."""
import sys, math
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
d = ImageChops.difference(a, b); px = list(d.getdata()); n = len(px) * 3
mae = sum(sum(p) for p in px) / n; mse = sum(c * c for p in px for c in p) / n
print('MAE %.3f  PSNR %.2f dB' % (mae, 99 if mse == 0 else 10 * math.log10(255 * 255 / mse)))
if len(sys.argv) > 3:
    out = Image.new('RGB', (a.width * 3, a.height)); out.paste(a, (0, 0)); out.paste(b, (a.width, 0))
    out.paste(d.point(lambda v: min(255, v * 4)), (a.width * 2, 0)); out.save(sys.argv[3])
