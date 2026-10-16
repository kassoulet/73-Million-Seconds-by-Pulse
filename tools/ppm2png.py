#!/usr/bin/env python3
"""python3 tools/ppm2png.py in.ppm out.png [scale]"""
import sys
from PIL import Image
im = Image.open(sys.argv[1]); s = int(sys.argv[3]) if len(sys.argv) > 3 else 1
if s > 1: im = im.resize((im.width * s, im.height * s), Image.NEAREST)
im.save(sys.argv[2])
