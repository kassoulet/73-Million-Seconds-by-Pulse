# 73 million seconds — JavaScript port

A study port of **"73 million seconds"** (pULSe, 1998) — a DOS/4GW demo — re-implemented
in plain JavaScript and runnable in the browser and in Node 22.

The original executable (`73MS.EXE`) and archive (`73MIL.SEC`) were reverse-engineered
instruction by instruction; the port reproduces the behaviour of the original engine
(data-driven script, effect pipeline, fixed-point/MMX inner loops) rather than
approximating "what the effect usually does". The demo and its assets remain
© Pulse 1998 — see [Credits](#credits).

**Live demo:** https://kassoulet.github.io/73-Million-Seconds-by-Pulse/

## What's here

- **Faithful engine port** — the original `script.unr` drives the demo: it creates
  buffers and *events* that run every frame in layer order. The JS engine parses the
  same script and scheduler, with the original expression evaluator (`compileExpr`).
- **Effect modules** reproducing the 1998 code, each derived from the disassembly:
  - `basic2d` — fade, blend, lowpass, matrix transforms, palette conversion, interpolator
  - `feedback` — echo, echo4/6, radial blur, parasite, Reebok, PlayRGB ani
  - `scene3d` — the real-time 3-D scenes (rasteriser, formats, animation)
  - `volumes` — plasma, metaballs, marching cubes, sprites
  - `flares` — particles/flares
- **Original music** — `tour2.xm` played through chiptune3/libopenmpt (bundled in `docs/vendor`).
- **No build step, no dependencies** — pure ES modules that run unmodified in a browser
  and in Node.
- **Reverse-engineering tooling** — a Unicorn-based harness that boots the original
  binary, calls any function with custom buffers, and renders reference ("golden")
  frames for byte-level comparison against the port.

## Repository layout

```
docs/                       GitHub Pages site (player + write-up)
  index.html                the page
  js/core.js                Buf, FX registry, expression compiler
  js/engine.js              script parser + per-frame scheduler
  js/xmtime.js              (order,row) -> seconds for tour2.xm
  js/fx/                    effect modules (basic2d, feedback, scene3d, volumes, flares)
  js/main.js                browser player
  notes/<name>.html         per-effect documentation fragments
  assets/                   converted artwork, scenes, script.unr, tour2.xm
re/                         reverse-engineering notes and tools
  NOTES.md                  everything known about 73MS.EXE / 73MIL.SEC
  rel0.bin / relB.bin       unpacked, relocated original image
  ds.py fx.py xref.py       disassembly / effect lookup / xref helpers
  emucore.py boot.py harness.py   Unicorn environment to call original functions
  golden.py                 headless render of the original engine (reference frames)
tools/                      render.mjs, mkraw.py, ppm2png.py, cmp.py, mkmanifest.mjs, browser-test.mjs
73MS.EXE 73MIL.SEC 73MS.NFO original (unmodified) demo files
ENGINE.md                   the port's engine contract / contributor guide
```

## Running locally

The site is static; serve `docs/` and open it:

```sh
cd docs && python3 -m http.server
# http://localhost:8000
```

Render the port headlessly at a given time (needs the raw assets built once):

```sh
python3 tools/mkraw.py                       # requires Pillow, builds build/raw
node tools/render.mjs 30 out.ppm --warm=1.5  # render port at t=30s, warm up for feedback
python3 tools/ppm2png.py out.ppm out.png
```

Compare against the original engine's own output at the same time:

```sh
cd re && python3 golden.py 30 31 0.05 golden/
python3 tools/cmp.py out.png golden/...
```

## How the reverse engineering works

`re/NOTES.md` documents the container format, the engine structures (effect table,
event and buffer records, layers, time source) and the loaders. The original is a
Watcom C/C++32 binary packed with UPX; `rel0.bin` is the unpacked image relocated to
base 0 so file offsets equal addresses. `harness.py` restores a booted machine state
in ~0.2 s and calls any original function (Watcom register convention) on your own
buffers, while `golden.py` runs the original engine headlessly and saves screen frames
used as ground truth for the port. See [`ENGINE.md`](ENGINE.md) for the port's API and
the documentation format used in `docs/notes/`.

## Credits

- Original demo *73 million seconds* © **pULSe 1998** (cookie, Unreal, Camel, Echo,
  Visualize, Voomie, Keygpls, MySinger and others). Assets are included for
  non-commercial study of the original code.
- Music: `tour2.xm`, played with [chiptune3](https://github.com/DrSnuggles/chiptune)
  / libopenmpt.
- This JavaScript port and the reverse-engineering notes: non-commercial, for study.
