# 73 million seconds (pULSe, 1998) - effects, engine and scenes

*73 million seconds* by **pULSe** (credits in `73MS.NFO`: cookie [analogz], Unreal, Camel, Echo, Visualize, Voomie, Keygpls, "my singer"; thanks line: distance, Destop, BStates, Silvereagle, Lazur, Yolk, Falcon). A DOS/4GW
demo: `73MS.EXE` (Watcom C/C++32, UPX-packed, 348 KB), the archive `73MIL.SEC` (3.4 MB) and the module `tour2.xm`. Source of every number below: `re/NOTES.md`, the
fragments in `docs/notes/*.html`, the port in `docs/js/` and `docs/assets/script.unr`. Statements about what is exact were measured by the port's author against
the original running under Unicorn (`re/harness.py`, `re/golden.py`); I did not re-run those comparisons while writing this document, I only re-checked that the
quoted disassembly matches `re/rel0.bin`.

## 0. At a glance

* **Display:** a 320x200 buffer (the script creates `SCREEN` 320x200x32 plus 8/16 bit helpers). 320x200 pixels are not square on a 4:3 CRT; the page shows the buffer
  as is and offers a display-only CRT overlay (scanline band per source row, canvas snapped to a multiple of 200 device pixels, see `README.md`). Pixel data is never touched by it.
* **The demo is a text file.** `script.unr` (in `73MIL.SEC`) is the whole show: `[order row] command ...` lines create buffers and *events* (effects). The engine runs
  every event each frame, in 4 layers, in insertion order. So the port is not a collection of hard-coded scenes but an engine (`engine.js`, `core.js`) that parses the same script,
  plus ~40 effect names implemented in five modules (`basic2d`, `feedback`, `scene3d`, `volumes`, `flares`).
* **Time is the music.** `(order,row)` of `tour2.xm` is converted to seconds (`xmtime.js`, table `re/xm_times.json`); an event's `Frame` variable is
  *centiseconds since the event was added* (`ctx.frame` = absolute centiseconds). Expressions in the script such as `1.0-clip10(Frame*0.003)` are compiled by the port's `compileExpr`
  (the original: compile at 0x505f8, evaluate at 0x50760; functions sin cos tan asin acos atan fabs sqrt sqr floor ceil clip10 clip11 clip).
* **Two kinds of buffers:** 8 bit buffers hold palette indices and only become colour through a separate `palette` effect (8 -> 32 bit); 32 bit buffers are `0x00RRGGBB`;
  16 bit is used once, for delta coding (aziz1, section 3).

### Where the effects are used (script order:row, times as quoted in the notes)

| order:row | what the script runs |
|---|---|
| 0:00 - 6:00 | `scene aziz1.lwe` into `SCREEN16` (light beams) + `interpolator` + `lowpass` + `palette medusa.pal`, `scene aziz2.lwe` (translucent bubbles), fades, 2 `radialblur` runs (3:05, 3:50) |
| 5:00 - 7:00 (33 - 48 s) | `playrgbani nebar.ani` (40 frames, 7 fps) lowpassed and added over the scene |
| 7:00 - 11:48 (48 - 79 s) | `scene vol.lwe` + `lowpass` + `radialblur`, kicked by `controlfloat` values on the beat |
| 11:50 - 12:60 (79 - 85 s) | `parasite` (two layers: `SCREEN3`, `PULSE`) |
| 12:60 - 15:16 (88 - 106 s) | `scene smoke.exp` + `setupflares` + 5 x `flareparticles` + `radialblur` + `blit` + `blend` with `TLO` |
| 15 - 17 (106 - 121 s) | `volume3D` / `metaballs` / `plasma1volume` / `morphvolume` / `mulvolume` -> `marchingcubes` into `box3.exp` |
| 17:12 - 18:60 (121 - 134 s) | `echo` + `radialblur` + `palette green2.pal` |
| 19 - 22 (135 - 165 s) | `echo6` + `lowpass 0.85` + `radialblur` |
| 23 - 26 (165.5 - 188.5 s) | `echo4` + `matrix` + `lowpass` + two `palette`, `xfade` to the background |
| 26 - 29 (188 - 211 s) | `scene obj1.lwe` + `displace247` + `colordistort` + `lowpass` + `radialblur` |
| 29 - 32 (211.6 - 235 s) | `reebok` + `palette medusa.pal` |
| 32:00 - 35:33 (about 245 - 262 s) | `scene box2.exp` with `renderoff`, `metaballs test2.mbs`, `volumesprites`, then `TheEnd` at 35:33 |

## 1. Engine model

Event objects are 0x4f bytes (+0x20/+0x24/+0x28 = init/run/free function, +0x2c = state, +0x30/+0x40 = output/input buffer descriptors, +0x48/+0x49 = start order/row); the
effect table at 0xbd2d0 is `name[16] + getDescriptor` records. The port's contract (`ENGINE.md`) is the same shape:

```js
FX.register('fade', {
  init(params, ev, ctx) { ... return state; },   // params = text of the 3rd {..} group
  run(state, ev, ctx)  { ... },                  // once per displayed frame
});
```

`ev.inputs` / `ev.outputs` are shared `Buf` objects (`Uint8Array` / `Uint16Array` RGB565 / `Uint32Array`), the same buffer can be read and written by different events in a layer,
so the order of events inside a layer *is* the compositing order. Time-varying parameters are expressions of `Frame`, evaluated every frame.

One thing is **not** deterministic in the original sense and the port copies the original's solution: every `rand()` in the demo (particles, texture blobs, parasite bands) is the
Watcom CRT LCG (`seed*0x41C64E6D + 12345`, bits 16..30) never seeded, so each run produces the same sequence; the port regenerates it from the same seed.

## 2. The 2D buffer effects

All of these are **byte exact** against the original according to the per-effect notes (random buffers or frames of the real script), with the exceptions listed under each.

### fade / xfade - lookup tables instead of multiplies

Alpha is `trunc(255*expr(Frame))`. At start-up the engine builds two 256x256 byte tables, `T284[a][v] = v*(256-a)>>8` and `T28c[a][v] = v*a>>8`. A frame costs one table row choice and
three lookups per pixel. In the port:

```js
const A = a > 255 ? 255 : a, IA = 256 - A;
const cr = (trunc(r*255) * A) >> 8;                       // colour part, once per frame
d[k] = (((((p>>16)&255)*IA)>>8) + cr) << 16 | ... ;       // pixel part
// xfade: d[k] = ((s0[k]*a)>>8) + ((s1[k]*(256-a))>>8) for the 3 colour bytes
```

Edge cases from the original: `a <= 0` on fade copies, xfade writes only the three colour bytes (the 4th is left alone), xfade with `a >= 255` copies in0. 32 bit (the script's case),
8 bit (fade to palette index `85*(r+g+b)`) and 16 bit variants exist in the original. Verified byte exact for 32 bit fade, 8 bit fade and xfade.

### blend - saturating add / subtract

`blend` treats two buffers as flat byte arrays whatever their format: mode 1 `min(255, a+b)`, mode 3 `max(0, a-b)`, mode 2 is a colour key (black in in1 -> take in0). Modes 11, 22 and 33 also exist; **33 is
a bug in the original that zeroes the output**, reproduced. On 8 bit buffers the add operates on palette indices (it saturates indices, not colours). Byte exact for modes 1, 2, 3, 11.

### lowpass - recursive blur with a one-pixel bug

A one-pole filter `y += (x-y)*a/128` run forward and then backward along each row, then down each column: a symmetric exponential kernel in O(1) per pixel. `a = trunc(128*s)`, `s >= 1` is a copy.

```js
// forward: y[0]=x[0]; y[i] = y[i-1] + (((x[i]-y[i-1]) * a) >> 7)
// backward: z = y[319]; for j = 319..0: z += ((TMP[j+1] - z) * a) >> 7; out[j] = z   (TMP[320] == 0)
```

The backward pass starts one dword (32 bit) or four bytes (8 bit) past the end of the scratch row, so the image drifts left by 1 or 4 pixels per application and the right edge is filtered against zero.
The port reproduces it (it shows up as a slow drift in the feedback scenes). **Exact for 32 bit; for 8 bit, exact when the scratch-row state equals the original's - otherwise only the 4 right-most columns differ**
(the scratch row is shared with the vertical pass and keeps state between calls). 16 bit is unsupported in the original too.

### matrix - 3x3 convolution through 9 lookup tables, with a lost centre tap

Used on `SCREEN8` for the embossed look (kernel `0.25 -0.5 0.25 0.25 -2.0 -0.25 -0.25 -0.5 -0.25`, bias `1.0`). Each coefficient becomes a 256-byte table `T_k[v] = trunc(v*m_k) & 255`, the loop does
nine lookups and 8 bit wrapping adds (negative coefficients work because of the wrap-around); the bias is `trunc(255*m)` = -1. Only interior pixels are written. **The original's centre tap is
broken** (`mov dl,[esi]` then `xor edx,edx`), so the -2.0 coefficient contributes `T4[0] = 0`; found by probing the original with single-coefficient kernels, reproduced. Byte exact on random images.

### interpolator + palette

`interpolator` integrates a delta-coded 16 bit buffer row by row (`acc += d; out = acc>>>0 > 255 ? 255 : acc`): see section 3, it is the reader for the beam scene. `palette` converts 8 to 32 bit from a raw
VGA DAC dump of 6 bit components with `(r<<16|g<<8|b) << 2`, so 63 becomes 252 and white never reaches 255. `colordistort` is `out = m2.bin[in]` on bytes. `fillbuffer` is a memset to 0
(its parameter is parsed and ignored). `blit` between equal depths is a memcpy; **the cross-depth conversion goes through the original's video library, which the emulator cannot run, so the rule used
by the port (grey ramp / luma) is an assumption and unverified.**

## 3. The 3D scenes (`scene` effect)

The demo has its own 3D engine, with formats made by the group's converters (`docs/notes/scene3d-*.html`):

* **UNLW (`*.lwe`)**: a LightWave scene stripped to motion data. Every animated entity is a list of 44-byte keys (x y z heading pitch bank, frame, linear flag, tension/continuity/bias).
* **LWV (`*.lwv`)**: the object referenced by an `.lwe` (the loader patches `x.lwo` into `x.lwv` and opens that in the archive): 12-byte header, 20 bytes/vertex (xyz uv), 70-byte surface records, 8 bytes/triangle.
* **UEXP (`*.exp`)**: an export from a 3D Studio MAX scene (`Box01`, `GeoSphere01`, `Omni01` names), 28-byte track keys. The parsers consume every file exactly to its last byte.

**Animation.** The `scene` event has a speed (scene frames per second) and a start frame: `t = (frame - start)*0.01*speed`; when `t` reaches `duration - 0.5` the start stamp resets (loop) and only
then the offset is added. Positions and angles are Kochanek-Bartels Hermite splines with LightWave's frame-spacing correction:

```js
const h1 = 2*u3 - 3*u2 + 1, h2 = -2*u3 + 3*u2, h3 = u3 - 2*u2 + u, h4 = u3 - u2;
tsA = (aP*(A-prev) + aN*(B-A)) * N1/(B.frame-prev.frame);
tdB = (bP*(B-A) + bN*(next-B)) * N1/(next.frame-A.frame);
out = h1*A + h2*B + h3*tsA + h4*tdB;
```

*Accuracy:* camera of aziz1 matched at 12 test frames to < 1e-4; over the 789 vertices of the aziz sphere the projected positions agree with the original to a median of 0.0002 pixels. This is a numerical
match in floating point, not a bit-exact one.

**Rasteriser.** Per frame: evaluate tracks, transform every vertex to camera space, project (`x = X*zoom/Z + w/2`), sort polygons into **1024 depth buckets** (linked list per bucket, far to near, painter's algorithm, no z-buffer), call one of ~25 hand-written
scanline fillers chosen from depth/shading/transparency. The demo uses two: the textured alpha-blended `0x6f75c` for 32 bit scenes (environment mapping: the camera-space vertex normal selects the texel, `u = 128 + 127.5*n.x`, `v = 128 + 127.5*n.y`
on `echo.png`/`echo2.png`) and the *beam* filler `0x612fc`.

Scenes: `aziz1/aziz2` (0 - 40 s, speed 32, start frame 200): a 789-vertex bubble sphere that never moves, a light on a 12-key spline, a camera on 10 keys diving through it. `vol.lwe` (4 fps): 68 vertices, 34 triangles. `smoke.exp` (69 fps): a GeoSphere, a tunnel camera on 6 keys and
five lights used only for flares. `box3.exp` (50 fps) and `box2.exp` (40 fps): boxes whose geometry is replaced every frame by the marching cubes, or not drawn at all (`renderoff`). `obj1.lwe` (3 fps): 3352 vertices / 6696 triangles turning 720 degrees per 160 frames,
with `displace247` pulsing the vertices: `v' = c + (v - c)(1 + 0.15 sin(|v-c|*1.27 + 0.015*Frame))`. `scene.lwe` is loaded and never played.

### Light shafts of the first scene: shadow volumes as scanline deltas

`aziz1.lwe` is loaded with flag `i` into the 16 bit buffer and, after `beamson`, its polygons are not drawn. For each polygon the three side quads of the prism made by pushing each vertex away from the light
(`v + (v - L)*9999`) are rasterised with a filler that stores no pixels: it adds `k` at the first pixel of each span and subtracts it after the last one.

```js
function spanDelta(y, xl, ul, vl, xr) {
  let x0 = q(xl), x1 = q(xr); if (x1 <= x0) return;
  const p = y * _W; _dst[p + x0] += _k; if (x1 < _W) _dst[p + x1] -= _k;   // Uint16Array wraps like the original
}
```

`interpolator` then does the row prefix sum, which turns the deltas into "how many shadow-volume faces cover this pixel" - the radial light shafts - via `lowpass` and `medusa.pal`. In the original, every row of the delta buffer sums to exactly 0 and deltas are multiples of 2 (the weight of a prism quad;
weight 7 for the polygon itself).

**Honest status: this scene is approximate.** The port reproduces the structure (dark core, radial wedges) but not the pixels: the original rejects quads that have a vertex behind the camera through an outcode flag and re-uses stale screen coordinates, which could
not be reproduced (measured: mean integrated value 32 in the original, 55 in the port, mean absolute difference 26). The 8 bit rendering of `smoke.exp` into `SCREEN8` uses the texture luminance as palette index, also noted as an approximation. The 32 bit environment-mapped scenes
were compared by eye against golden frames. The golden-frame harness initially rendered the 3D scenes black: the emulation snapshot lacked the x87 control word, so Unicorn ran with 24-bit precision and the magic-number conversion (asm write-up, section 9) gave 0; `FPCW = 0x37f` fixed it.

## 4. Feedback effects

### radialblur - in-place zoom feedback (exact: 5 consecutive frames, 0 of 64000 bytes differ)

Each pixel of the 8 bit buffer becomes itself plus a fraction of the picture sampled a little nearer the centre. Four quadrants are processed outward from the centre, writing into the very buffer they read, so a pixel samples neighbours *already blurred in this pass* and streaks propagate across the whole screen in one frame.
Two tables are rebuilt each frame in 26.6 fixed point: `xtab[x] = trunc((x-cx)*64*step)` and `ytab[y] = trunc((y-cy)*64*step*5/6)` (the 5/6 is the 200/240 pixel aspect). The bilinear interpolation has no multiply: a 32 KB table `T[f][d] = trunc(d*f/64)` (64 fractions x 512 differences) gives `a + T[f][b-a]` three times.

```js
pass(cyi, -1, cxi - 1, -1, 0); pass(cyi, -1, cxi, 1, W);
pass(cyi + 1, 1, cxi - 1, -1, 0); pass(cyi + 1, 1, cxi, 1, W);
const va = a + (((c - a) * fy) / 64 | 0), vb = b + (((d - b) * fy) / 64 | 0);
const v  = va + (((vb - va) * fx) / 64 | 0);
data[o] = Math.min(255, data[o] + att[v]);      // att[k] = round(k * strength)
```

`controlfloat` writes a global that only radialblur reads: while positive it *replaces* the strength expression and is multiplied by 0.8 per call - the beat kick, decaying (the script sets 0.8/0.6/0.5/0.9 on the song's beats between 9:16 and 11:48).
A final loop averages the column left of the centre (`p[x-1] = (p[x]+p[x-2])/2`) to hide the seam. Centre, strength and step are all script expressions, e.g. `{160+150*sin(Frame*0.01) 100+90*cos(Frame*0.01) 0.5+0.3*sin(Frame*0.005) -0.03}`.

### echo - zoomed echo tunnel (exact: 3 frames, both ping-pong parities)

A 256x256 picture (`ways.tga`) is stretched over the screen through a twist table built once, `(x*256/320, y*256/200)` displaced by `15*sin(0.0005*(x-160)*(y-100))` in both coordinates, packed as a 16 bit index. The picture is scrolled on a Lissajous path
(`T = 0.04*frame`, offset `6144 + 256*(ceil(32cos T)+ceil(4sin T)) + ceil(32sin T) + ceil(8cos T)`). Each frame the previous result is sampled through a zoom table (`0.80`), averaged 2x2, attenuated (`0.70`) and the picture is added with saturation:

```js
const s15 = Math.sin((x - 160) * (y - 100) * 0.0005) * 15.0;
warp[y*320+x] = ftol(ftol(f32(y*256/200) + s15) * 256 + f32(x*256/320) + s15) & 0xffff;
dst[i] = Math.min(255, att[(src[p] + src[p+1] + src[p+320] + src[p+321]) >> 2] + atom[(warp[i] + ofs) & 0xffff]);
```

The original's zoom tables have one slot too few, so x=0 and y=0 read an uninitialised slot (zero): the first row and column sample from (0,0). Kept.

### echo4 and echo6 - an additive 3D object, then a smear (exact)

Both share one small polygon pipeline. **echo4** (165.5 - 188.5 s): a cage of 3x6 square planes (at +-100, +-60, +-20 on each axis, 72 vertices, 36 triangles), rotated by three angles derived from the expression, pushed 500 units away and drawn *additively* with a perspective-correct texture mapper into a cleared 8 bit buffer. The texture is 2500 random soft blobs generated at start (via the unseeded `rand()`). Since addition commutes, no depth sorting is needed
(the original still files triangles in 4096 buckets). The expression `Frame*0.8` is not a value but a clock: only its change since the previous frame is used. The picture is then smeared so bright line crossings become glow trails:

```js
// glow smear: out = sat(in + round(0.65*previous out)), first along rows then down columns
const v = buf[i] + T[p]; p = Math.min(255, v); buf[i] = p;
```

The span rasteriser inverts 1/z only every 8 pixels and steps u,v linearly in between. **echo6** (134.8 - 165 s) uses the same pipeline on a sphere: an octahedron of radius 300 subdivided four times by an integer midpoint routine (1026 vertices, 2048 triangles), each vertex scaled radially by a sum of three sines of its own integer coordinates (the wobble):

```js
const t1 = Math.sin((x|0)/D + P ) * 0.3 + 2/3;
const t2 = Math.sin((y|0)/D + P2) * 0.3 + 2/3 + t1;
const s  = f32(Math.sin((z|0)/D + P3) * 0.3 + 2/3 + t2);
w[o] *= s; w[o+1] *= s; w[o+2] *= s;
```

then back-face culled with a triple product, and followed in the script by `lowpass 0.85` and `radialblur` instead of a smear. Verified: 4 frames of each of echo4 and echo6 pixel-exact; the 3D pipeline alone against 300 random triangles including clipped and near-plane cases (0 differing pixels); both texture generators 65536/65536 bytes; echo6 mesh identical (1026 / 2048).

### reebok - six additive rotozoom layers (exact: 3 frames)

The 256x256 `medusa` picture is drawn six times with different zoom/phase (0,42,84,126,168,210) and added with saturation. Rotation angle `0.006*elapsed*0.6`, zoom `(sin(a)*0.5 + 2)*phase/32`. Each layer has a 256 byte brightness table `trunc(k*0.7*sin(0.9q^2 + 2.24q))`, `q = phase/256`, that can be negative; the byte wraps, producing the shimmer.
The mapper works on an 8x8 grid (41x26 corner points): corner texture coordinates are computed in floating point and converted by the magic-number trick; inside a cell the texture coordinates are interpolated incrementally. A quirk kept bit-exactly: `ecx` and `edx` still hold destination-pixel and integer-step bytes in their low bytes, which get added to the fractions as well.

### parasite - wobbling texture bands (exact: 3 frames, 0 of 64000 pixels)

Each scanline is cut into 16 bands whose left edges follow `X[j] = trunc(40*sin(y*K1[j] + e*K2[j]) * sin(0.01*y + e*K4[j]) + 40*j)`, `e = 0.01*time`, K's drawn once from the unseeded `rand()`. Bands are painted right to left with a one-pixel strip of `som.png` stretched to the band width, row `(37*j + y + 40*e) & 255`.
Colour comes from a 256x256 table of 32 bit colours: palette entry times `cos^3((1 - L/256)*pi/2)/64`, with the level `L = min(255, 32*255/width)` - wide bands dark, narrow bands bright, hence the pulsing glow. The step through the texture row is the 16.16 value `255/width`.

```js
const S = rint(255 / width * 65536), L = Math.min(255, rint(Math.abs(255/width) * 65536) >> 11);
pos += (S >> 16) + carry;  esi += (S << 16) >>> 0;  carry = esi overflowed
```

### playrgbani - 24 bit animation with cross-fade (exact: 5 frames)

The 40-frame 320x180 `nebar` animation plays at 7 fps; the shown picture is the **cross-fade of frame floor(f) and the next**, weight = fractional part, so 7 fps looks smooth. The position wraps with `fmod` (loop flag), the "next" frame after the last is frame 0.
`tabA[i] = trunc(i*(1-frac))` and `tabB[i] = trunc(i*frac)` are rebuilt each frame; every channel is `tabA[a] + tabB[b]`. The animation is centred in the 200-line buffer (y offset 10, the other rows untouched). The original `nebar.ani` is a bzip-like block coder (type `b` in the archive); the web port reads it from an 8x5 PNG sheet.

## 5. Particles and volumes

### flareparticles / setupflares (blitter bit-exact on tested sprites)

88 - 106 s: each of five lights of `smoke.exp` owns an event with 100 particles. A particle is born on the moving light, drifts with a random velocity, grows 0 -> 200 -> 300 units while fading `0.2 -> 0.01`, and is reborn. Each particle is a screen-aligned square, texture-mapped with the 128x128 `flare2` picture and added to the 8 bit buffer through a 256-row intensity table `(texel*intensity)>>8`.

```js
if (age > l1) { t = (age-l1)/l2; size = (p38-p34)*t+p34; inten = (p44-p40)*t+p40; }
else          { t = age/l1;      size = (p34-p30)*t+p30; inten = (p40-p3c)*t+p3c; }
idx = Math.min(255, Math.trunc(inten*255));
```

`setupflares` only stores its expression (`2`) in the scene record, where the 3D renderer uses it as the size factor of its own light halos; the particles ignore it.

### The volume system (16x16x16 float fields)

A *volume* is a named block of 4096 floats (index `x + 16y + 256z`). The script builds fields with `volume3D`, `clearvolume`, `copyvolume`, `metaballs`, `plasma1volume`, `addvolume`/`subvolume`/`mulvolume`, `fadevolume` and `morphvolume`, all writing float32, so a `Float32Array` port is exact (bit-identical on 6 frames of the real chain `copy/morph/metaballs/plasma/mul/morph/fade`).

* **metaballs:** reads 8 text lines "X Y Z R C" (expressions of `Frame`). Falloff is a quartic in the *squared* distance, no square root: `f(d2) = (A*d2 + B)*d2 + C`, `A = C/R^4`, `B = -2C/R^2` - it equals C at the centre and reaches 0 with zero slope at `d2 = R^2`. Negative C digs holes. The code tabulates 16 squared distances per axis and clips the loops to the ball's bounding box.
* **plasma1volume:** `v = a + b*sin(r + 0.02*Frame)`, r = distance from the cube centre; distances tabulated once, only one octant (512 sines) is computed per frame and mirrored in x, y, z. In the script it is multiplied into the metaball field so the blobs get a travelling ripple.
* **morphvolume** is `A*t + B*(1-t)` (the first source gets weight `t`), `fadevolume` with `-1` inverts the field.

### marchingcubes (106 - 121 s, bit-identical on 9 test volumes)

The 16^3 field is polygonised each frame at iso-level 0.5 (`jabole box02 OurVolume 1 0.5`) straight into the mesh of a loaded `.exp` object (vertices, normals, triangle list replaced; the polygons keep the material of the first original polygon). For each sample the three edges toward the lower neighbours are tested, vertices are placed by linear interpolation, and the **normal** is the interpolated central-difference gradient normalised with a table-driven `1/sqrt`. Triangles come from the classic 256-case table. Limits in the original: 4000 polygons and 12288 vertices per object, with no overflow check.
A second pass with `fadevolume -1` produces the negative lobes into `box01`.

```js
const m = ((T < vi[s-1]) << 3) | ((T < a) << 2) | ((T < vi[s-16]) << 1) | (T < vi[s-17] ? 1 : 0);
mask[s + 256] = m;                      // read back 256 samples later, when the next z plane arrives
const cs = (m << 4) | mask[s];
for (const e of TRI[cs]) out[n++] = e + (s - 273);
```

### volumesprites (245 - 262 s, blitter bit-identical on 8 sprites)

The last scene draws no polygons (`renderoff`). For each voxel with `35*value >= 1` (clamped to 120), the voxel position inside the bounding box of `box01` is transformed with the scene camera and drawn as a square of `35*value*150/z` pixels (skipped under 3.5), additively, with a palette ramp `pal[i] = i/160 * colour * 256`.
**Quirk reproduced:** the texture and the colour are not taken from the scene but from a global "current material" the flare effects left behind (measured at t = 237 s: `f2.omni01`, texture `flare2`, colour (0.38, 0.553, 0.494), hence teal star sprites). The projection relies on `scene3d.js`.

## 6. What is exact, what is not (summary)

| area | status |
|---|---|
| fade, xfade, blend, interpolator, palette, colordistort, matrix, lowpass 32 bit | byte exact vs original |
| lowpass 8 bit | exact if scratch-row state equals the original's, else the 4 right-most columns differ |
| blit between different depths | assumed rule, not verified |
| radialblur, echo, echo4, echo6, reebok, parasite, playrgbani | pixel exact on 3 - 5 captured frames each |
| flares blitter, volumesprites blitter, volumes, metaballs, marching cubes | bit-identical on the tested inputs |
| 3D transforms / animation | numerically close (median 0.0002 px), not bit exact |
| aziz1 shadow-volume beams | structural match only (mean abs diff 26 on the integrated buffer) |
| 8 bit `smoke.exp` scene | approximation (texture luminance as index) |
| 32 bit env-mapped scenes | compared by eye with golden frames |

The golden harness renders at 0.2 s per frame and can only be started from t=0 (the script consumes one command per frame) or with the `COARSE` fast-forward; feedback effects therefore need a warm-up (`render.mjs --warm=1.5`) before a frame can be compared at an arbitrary time.
