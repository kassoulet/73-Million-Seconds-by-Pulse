# JS port — engine contract (read this first)

Goal: a faithful JavaScript port of the 1998 demo "73 million seconds" (Pulse) that runs in a browser (GitHub Pages, no build step,
no external libraries) and in node 22 (headless tests). The original is a data-driven engine: `script.unr` (copied to
`docs/assets/script.unr`) creates buffers and **events** (= effects) which run every frame in layer order. Read `re/NOTES.md` for what is known about
the original binary and how to use the reverse-engineering tools. The script (docs/assets/script.unr) is short — read all of it.

## Layout
```
docs/index.html            site (owned by the lead)
docs/js/core.js            Buf, FX registry, compileExpr   (lead)
docs/js/engine.js          script parser + scheduler        (lead)
docs/js/xmtime.js          (order,row) -> seconds           (lead)
docs/js/fx/index.js        imports basic2d.js feedback.js scene3d.js volumes.js flares.js (each optional)
docs/js/fx/<module>.js     effect modules — one owner per module
docs/notes/<name>.html     documentation fragments for the site (one per effect or group)
docs/assets/*              assets (png/jpg/idx/pal/exp/lwe/lwv/...)
re/                        reverse-engineering tools, golden frames  (see re/NOTES.md)
tools/render.mjs           node tools/render.mjs <seconds> out.ppm [--warm=1.5]   renders our port at time t (script is replayed, frames warm-up for feedback effects)
tools/ppm2png.py, tools/cmp.py   convert / compare images
```
Run `python3 tools/mkraw.py` once (needs Pillow, see PY in re/NOTES.md) to create `build/raw` used by render.mjs.

## JS API
```js
import { FX, Buf, compileExpr } from '../core.js';
FX.register('fade', {
  init(params, ev, ctx) { ... return state; },   // params = text of the 3rd {..} group (ev.groups[2]); ev.groups[0..3] are all groups, ev.inputs / ev.outputs are Buf[] (already resolved)
  run(state, ev, ctx)  { ... },                  // called once per displayed frame
  free(state, ev, ctx) {},                       // optional
});
```
* `Buf {name,w,h,bpp,data,pal}`: bpp 8 -> `Uint8Array` (palette index), 16 -> `Uint16Array` RGB565, 32 -> `Uint32Array` `0x00RRGGBB`.
  Buffers are created by the script (`createBuffer NAME w h bpp [file]`) and are shared by name between events, so effects must read/write `ev.inputs[i].data` / `ev.outputs[i].data` (never replace the arrays). `ev.inputs/outputs` may be the same Buf.
* `ev.local` = the script variable `Frame` for this event = **centiseconds since the event was added**. `ctx.frame` = absolute centiseconds, `ctx.time` seconds,
  `ctx.control` = last `controlfloat` value, `ctx.lwotr`, `ctx.lwoshading`, `ctx.beams`, `ctx.render` = values of the matching script commands.
  `compileExpr("1.0-clip10(Frame*0.003)")` returns `f(Frame)` (functions: sin cos tan asin acos atan fabs sqrt sqr floor ceil clip10 clip11 clip).
* Assets (`ctx.assets`): `image(name)` -> `{w,h,rgb:Uint32Array}` (name as in the script, e.g. `'som.png'`, `'sleep.tga'` resolves to the converted png), `idx(name)` -> `{w,h,data,pal}` for the 8-bit tga images,
  `bin(name)` -> `Uint8Array` (pal, m2.bin, v8.dat, *.lwv, *.exp ...), `text(name)`. In the browser they are preloaded before the demo starts, so they are synchronous.
  If you need another conversion of an asset (e.g. nebar.ani as sheet), add it to `docs/assets` and teach `ctx.assets` in `tools/render.mjs` AND ask the lead to add the browser side (or add a small, clearly commented, additive change to `docs/js/engine.js`).
* Hooks for non-effect script commands live in `engine.js`: `Hooks.loadScene(file, bufName, flag, ctx)` and `Hooks.loadAnim(file, pal, ctx)`; the returned objects are stored in `ctx.scenes[file.toLowerCase()]` / `ctx.anims[...]`.
* An unknown effect is skipped with a console warning, so partial work is fine.

## Rules
* Pure ES modules, no dependencies, no build step, must run unmodified in a browser and in node 22. Keep per-frame work allocation-free (typed arrays allocated in `init`), 320x200 at 60 fps in a browser is the target.
* Port the *behaviour of the original code*: derive the algorithm from the disassembly (`re/ds.py`, `re/fx.py`) — not from what the effect "usually" does. Keep names/constants of the original where they matter. Where original code uses fixed point / MMX, reproduce the arithmetic (rounding, truncation, saturation) closely enough that results match the golden frames.
* Verify: call the original function in the harness (`re/harness.py`) with a synthetic buffer and compare to your JS output (`node` reading a dump), or compare a rendered frame with a `re/golden.py` frame at the same time (`tools/cmp.py`). Report the measured error.
* Documentation for the site: for each effect (or group) write an HTML fragment `docs/notes/<name>.html` with ONE root element `<section class="fx" id="fx-<name>">` containing: `<h3>` title, 1-3 short paragraphs (plain English: what it does visually, how the original does it, retro-context such as fixed-point maths, MMX, tables, 320x200 constraints), the **interesting inner loop(s) as real disassembly excerpts** of the original in `<pre class="asm">` (keep 10-40 lines, address-annotated, with short `; comments` you add yourself, mention the source address), the equivalent JS in `<pre class="js">`, and a small `<dl class="facts">` (script usage, parameters, buffers, where in the timeline). No external CSS/JS; use only: h3, h4, p, ul/li, pre, code, dl/dt/dd, em, strong, table.
* Do not edit files you do not own. `core.js`/`engine.js` are the lead's: if you need a change that is more than a few additive lines, describe it in your final report instead.
* Final report (your last message): what is implemented, what is verified and how (numbers), what is approximate/missing, files written, and any facts about the original worth putting on the site (concise).
