#!/usr/bin/env python3
"""Pre-decode docs/assets images to raw uint32 (0x00RRGGBB, little endian) in build/raw for the node test harness.
usage: python3 tools/mkraw.py   (needs Pillow)"""
import os, json
from PIL import Image
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'docs/assets'); dst = os.path.join(root, 'build/raw'); os.makedirs(dst, exist_ok=True)
meta = {}
for f in sorted(os.listdir(src)):
    if f.lower().endswith(('.png', '.jpg')):
        im = Image.open(os.path.join(src, f)).convert('RGB'); w, h = im.size
        px = im.tobytes(); out = bytearray(w * h * 4)
        out[0::4] = px[2::3]; out[1::4] = px[1::3]; out[2::4] = px[0::3]  # little endian 0x00RRGGBB -> bytes B,G,R,0
        open(os.path.join(dst, f + '.rgb32'), 'wb').write(out); meta[f] = [w, h]
json.dump(meta, open(os.path.join(dst, 'meta.json'), 'w'))
print(len(meta), 'images')
