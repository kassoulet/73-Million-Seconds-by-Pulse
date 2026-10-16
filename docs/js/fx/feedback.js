// feedback.js - "feedback / zoom" effects of 73 million seconds, ported from the 1998 executable (see docs/notes/feedback-*.html).
//   radialblur  0x1ba9a/0x1bb67 + kernel 0x6fd0/0x35ee2     in-place zoom/streak feedback            (8 bit)
//   echo        0xe67d/0xe9f9 + 0xb363f                      warped, zoomed echo of a 256x256 picture (8 bit)
//   playrgbani  0xf96c/0xfa5f + 0x4f601                      24 bit animation player with cross-fade   (32 bit)
//   reebok      0x199f3/0x19c9b + 0x59244                    6 additive rotozoom layers                (8 bit)
//   parasite    0x19389/0x1969f + 0x59190                    16 wobbling texture bands per scanline    (32 bit)
//   echo4/echo6 0x1b71a.. / 0x1bcfa.. + the 3D pipeline 0x8a69a (clip) / 0x8985d (raster) additive textured meshes (8 bit)
// Everything works on 8-bit palette-index buffers where possible; the colours come later from the `palette` effect.
// Each effect was verified byte-for-byte against the original code (see the end-of-task report / docs/notes).
import { FX, compileExpr } from '../core.js';

const f32 = Math.fround;
const ftol = (x) => Math.trunc(x);               // 0x1ed6a: frndint with the FPU rounding mode forced to "truncate"
const rint = (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && (r & 1)) ? r - 1 : r; }; // fist: round to nearest even
const exprs = (s) => String(s).trim().split(/\s+/);   // the original does sscanf("%s %s %s %s"): expressions contain no blanks

// ------------------------------------------------------------------------------------------------
// radialblur
// ------------------------------------------------------------------------------------------------
// Parameters (4 expressions, evaluated every frame with Frame = centiseconds since the event started):
//   cx cy   centre of the effect (pixels)       strength  gain applied to the sampled pixel (0..1)
//   step    zoom step per pixel of distance from the centre (negative = sample towards the centre)
// Output = input buffer (in place): dst += strength * bilinear(dst sampled at p + (p - c) * step), saturated at 255.
// The sample is read from the very same buffer which is being updated, the four quadrants are walked outward
// from the centre, so a pixel samples a neighbour that was *already* updated in this pass: streaks propagate.
export function radialBlurKernel(data, cx, cy, strength, step, work) {
  const W = 320, H = 200;
  cx = f32(cx); cy = f32(cy); strength = f32(strength); step = f32(step);
  const stepY = f32(step * (5 / 6));           // 0x6fe3: fmul qword [0xb6c60] (=0.8333) then stored as float
  const xt = work.xt, yt = work.yt, att = work.att;
  for (let i = 0; i < W; i++) xt[i] = ftol((i - cx) * 64 * step);      // 26.6 fixed point source offset
  for (let j = 0; j < H; j++) yt[j] = ftol((j - cy) * 64 * stepY);
  for (let k = 0; k < 256; k++) att[k] = rint(k * strength) & 255;      // 0x35f43: fist k*strength -> byte table
  const cx0 = ftol(cx);
  let cxi = cx0, cyi = ftol(cy);
  cxi = cxi < 0 ? 0 : cxi > W - 1 ? W - 1 : cxi; cyi = cyi < 0 ? 0 : cyi > H - 1 ? H - 1 : cyi;
  // 4 passes: (rows cy..0, x < cx descending), (rows cy..0, x >= cx ascending), then the same for rows cy+1..199
  const pass = (y0, dir, xFrom, xDir, xEnd) => {
    for (let y = y0; y >= 0 && y < H; y += dir) {
      const ty = yt[y], fy = ty & 63, dy = (ty >> 6) * W, row = y * W;
      for (let x = xFrom; xDir < 0 ? x >= xEnd : x < xEnd; x += xDir) {
        const tx = xt[x], fx = tx & 63;
        const p = row + x + dy + (tx >> 6);
        const a = data[p], b = data[p + 1], c = data[p + W], d = data[p + W + 1];
        // three linear interpolations, each "a + trunc((b-a)*f/64)" (table at 0x102324 built by 0x70fc)
        const va = a + (((c - a) * fy) / 64 | 0);
        const vb = b + (((d - b) * fy) / 64 | 0);
        const v = va + (((vb - va) * fx) / 64 | 0);
        const o = row + x;
        const s = data[o] + att[v & 255];
        data[o] = s > 255 ? 255 : s;                                // add + sbb/or = unsigned saturation
      }
    }
  };
  pass(cyi, -1, cxi - 1, -1, 0); pass(cyi, -1, cxi, 1, W);
  pass(cyi + 1, 1, cxi - 1, -1, 0); pass(cyi + 1, 1, cxi, 1, W);
  // 0x70d5: the seam left of the centre column (unclamped ftol(cx)) is smoothed: p[x-1] = (p[x] + p[x-2]) >> 1, all 200 rows
  for (let y = 0, p = cx0; y < H; y++, p += W) if (p >= 2 && p < W * H) data[p - 1] = (data[p] + data[p - 2]) >> 1;
}

FX.register('radialblur', {
  init(params) {
    const e = exprs(params);
    return { fx: compileExpr(e[0]), fy: compileExpr(e[1]), fs: compileExpr(e[2]), fa: compileExpr(e[3]),
      work: { xt: new Int32Array(320), yt: new Int32Array(200), att: new Uint8Array(256) } };
  },
  run(st, ev, ctx) {
    if (st.frame0 === undefined) st.frame0 = f32(ctx.frame);
    const F = f32(f32(ctx.frame) - st.frame0);                                       // Frame = time since the first run (float32 like the original)
    const out = ev.outputs[0] || ev.inputs[0];
    const cx = st.fx(F), cy = st.fy(F), step = st.fa(F);
    let strength = st.fs(F);
    // `controlfloat v` (script) writes the global at 0x11802c, and radialblur is its only reader: while it is > 0 it
    // REPLACES the strength expression and then decays by 0.8 on every call (a beat "kick" that fades out).
    if (ctx.control > 0) { strength = ctx.control; ctx.control = f32(ctx.control * 0.8); }
    radialBlurKernel(out.data, cx, cy, strength, step, st.work);
  },
});

// ------------------------------------------------------------------------------------------------
// echo   (script: `echo pa1 {ATOM} {SCREEN8} {0.80 0.70}`)
// ------------------------------------------------------------------------------------------------
// A persistent 320x200 8-bit "echo" buffer P is zoomed/blurred every frame and a scrolling, warped copy of a
// 256x256 picture (ways.tga) is added on top:
//   P'(x,y) = min(255, att[ box2x2(P at (x',y')) ] + ATOM[(warp[x,y] + ofs(t)) & 0xffff])
//   x' = trunc((x-160)*zoom + 160), y' = trunc((y-100)*zoom + 100)       zoom = 1st parameter (0.80)
//   att[i] = trunc(i * decay)                                           decay = 2nd parameter (0.70)
//   warp = per-pixel 16 bit index into the 256x256 picture, a fixed twist: (x,y)*256/(320,200) + 15*sin(0.0005*(x-160)*(y-100))
//   ofs(t) = 6144 + 256*(ceil(32 cos T)+ceil(4 sin T)) + ceil(32 sin T) + ceil(8 cos T),  T = 0.04 * absolute time (centiseconds)
// P' is both copied to the output buffer and kept as the next frame's input (the original ping-pongs two buffers).
// The inner loop of the original (0xb363f) is self-modifying code: the buffer addresses and the offset are patched
// into the displacement fields of the instructions every frame, and the tables are copied into the code segment.
FX.register('echo', {
  init(params) {
    const [zoom, decay] = params.trim().split(/\s+/).map((s) => f32(parseFloat(s)));
    const W = 320, H = 200;
    const warp = new Uint16Array(W * H), xt = new Int32Array(W), yt = new Int32Array(H), att = new Uint8Array(256);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let fx = f32(x * 256 / 320), fy = f32(y * 256 / 200);
      const s15 = Math.sin((x - 160) * (y - 100) * 0.0005) * 15.0;
      fx = f32(fx + s15); fy = f32(fy + s15);
      warp[y * W + x] = (ftol(ftol(fy) * 256 + fx)) & 0xffff;
    }
    for (let x = 1; x < W; x++) xt[x] = ftol((x - 160) * zoom + 160);   // x = 0 uses a never-initialised table slot = 0
    for (let y = 1; y < H; y++) yt[y] = ftol((y - 100) * zoom + 100);
    for (let i = 0; i < 256; i++) att[i] = ftol(i * decay) & 255;
    return { warp, xt, yt, att, a: new Uint8Array(W * H), b: new Uint8Array(W * H) };
  },
  run(st, ev, ctx) {
    const atom = ev.inputs[0], out = ev.outputs[0]; if (!atom || !out) return;
    const T = f32(ctx.frame) * 0.04;
    const ofs = 6144 + 256 * (Math.ceil(32 * Math.cos(T)) + Math.ceil(4 * Math.sin(T))) + Math.ceil(32 * Math.sin(T)) + Math.ceil(8 * Math.cos(T));
    const src = st.b, dst = st.a, { warp, xt, yt, att } = st, A = atom.data, W = 320, H = 200;
    for (let y = 0, i = 0; y < H; y++) {
      const row = yt[y] * W;
      for (let x = 0; x < W; x++, i++) {
        const p = row + xt[x];
        const v = att[(src[p] + src[p + 1] + src[p + W] + src[p + W + 1]) >> 2] + A[(warp[i] + ofs) & 0xffff];
        dst[i] = v > 255 ? 255 : v;
      }
    }
    out.data.set(dst); st.a = src; st.b = dst;          // ping-pong
  },
});

// ------------------------------------------------------------------------------------------------
// playrgbani   (script: `playrgbani plani {} {SCREEN2} {nebar.ani 320 180 10 0 39 1 7.0}`)
// ------------------------------------------------------------------------------------------------
// Plays a 24 bit animation (nebar.ani, 40 frames of 320x180) into a 32 bit buffer, cross-fading between two
// consecutive frames.  Parameters (sscanf "%s %d %d %d %d %d %d %f"): name, frame width, frame height,
// destination y offset (10 = centred letterbox), first frame, last frame, loop flag, speed in frames per second.
// The animation is read from docs/assets/nebar_sheet.png (8 x 5 sheet of 320x180 frames).
// Original: handler 0xf96c/0xfa5f, blend loop 0x4f601 (self-modifying: the two 256-entry weight tables are patched
// into the displacement of the table lookups, 3 bytes in -> 4 bytes out per pixel).
FX.register('playrgbani', {
  init(params, ev, ctx) {
    const t = params.trim().split(/\s+/);
    const st = { name: t[0], w: +t[1], h: +t[2], yofs: +t[3], first: +t[4], last: +t[5], loop: +t[6], fps: f32(parseFloat(t[7])), t0: null,
      tabA: new Uint8Array(256), tabB: new Uint8Array(256), sheet: null };
    try { st.sheet = ctx.assets.image('nebar_sheet.png'); } catch (e) { console.warn('playrgbani: nebar_sheet.png missing'); }
    return st;
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0]; if (!out || !st.sheet) return;
    const fr0 = f32(ctx.frame); if (st.t0 === null) st.t0 = fr0;
    let f = f32(f32(f32(fr0 - st.t0) / 100) * st.fps);                    // frames elapsed
    const last = st.last;
    const fix = (v) => (last < v ? (st.loop ? v % last : last) : v);     // 0x4f58c = fmod
    f = f32(fix(f));
    let g = f32(1 + f); g = f32(fix(g));
    const frac = f32(f - Math.floor(f)), inv = f32(1 - frac);
    const ia = ftol(f32(st.first + f)), ib = ftol(g);
    const { tabA, tabB } = st;
    for (let i = 0; i < 256; i++) { tabA[i] = ftol(i * inv) & 255; tabB[i] = ftol(i * frac) & 255; }
    const S = st.sheet.rgb, SW = st.sheet.w, w = st.w, h = st.h, D = out.data;
    const oa = ((ia >> 3) * h) * SW + (ia & 7) * w, ob = ((ib >> 3) * h) * SW + (ib & 7) * w;
    for (let y = 0; y < h; y++) {
      let pa = oa + y * SW, pb = ob + y * SW, d = (y + st.yofs) * out.w;
      for (let x = 0; x < w; x++, pa++, pb++, d++) {
        const a = S[pa], b = S[pb];
        D[d] = ((tabA[(a >> 16) & 255] + tabB[(b >> 16) & 255]) << 16 | (tabA[(a >> 8) & 255] + tabB[(b >> 8) & 255]) << 8 | (tabA[a & 255] + tabB[b & 255])) & 0xffffff;
      }
    }
  },
});

// ------------------------------------------------------------------------------------------------
// reebok   (script: `reebok juu {SCREEN8} {SCREEN8} {medusa.tga}`)
// ------------------------------------------------------------------------------------------------
// Six additive rotozoom layers of a 256x256 8-bit picture (medusa) drawn into the 8-bit buffer.  The screen is
// cut into 8x8 pixel cells; the texture coordinates of the 41 x 26 grid corners are computed per layer (rotation +
// zoom around the centre, 16.16 fixed point), and each cell is filled by interpolating bilinearly between its four
// corners in fixed point (0x59244).  Every texel goes through a 256 byte brightness table (a different one per
// layer) and is added to the destination with unsigned saturation.  The texture is kept in a 64K aligned block so that
// the 8 bit registers bl/bh (u,v integer parts) wrap by themselves; the sub-pixel fractions live in esi/ebp and the carry
// of `add esi,ecx` / `add ebp,edx` feeds `adc bl,dl` / `adc bh,dh`.  A quirk reproduced here: ecx/edx still contain
// junk in their low bytes (the destination pixel, the integer step) which is added to the fractions too.
const rint32 = (x) => rint(x) | 0;
const SIXTH = [0, 42, 84, 126, 168, 210];
FX.register('reebok', {
  init(params, ev, ctx) {
    const out = ev.outputs[0];
    const tex = ctx.assets.idx(params.trim().split(/\s+/)[0]).data;
    return { w: out.w, h: out.h, gw: ((out.w / 8) | 0) + 1, gh: ((out.h / 8) | 0) + 1, tex, t0: null, prev: 0,
      ph: Float32Array.from(SIXTH), tbl: new Uint8Array(256),
      rowA: new Int32Array(2 * 64), rowB: new Int32Array(2 * 64) };
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0]; if (!out) return;
    const fr = f32(ctx.frame); if (st.t0 === null) st.t0 = fr;
    let e = f32(f32(fr - st.t0) * 0.6);
    const a = f32(e * 0.006);
    const de = f32(e - st.prev);
    for (let i = 0; i < 6; i++) { let p = f32(st.ph[i] - de); if (p < 0) p = f32(p + 256); st.ph[i] = p; }
    st.prev = f32(st.prev + de);
    const W = st.w, D = out.data, tex = st.tex, tbl = st.tbl;
    const cellsX = W >> 3, cellsY = out.h >> 3, sa = f32(Math.sin(a)), ca = f32(Math.cos(a));
    const cxg = f32(st.gw * 0.5), cyg = f32(st.gh * 0.5), kx = f32(320 / st.w), ky = f32(200 / st.h);
    // grid corner (u,v) in 16.16, magic-number conversion = round to nearest even
    const vertRow = (arr, r, scale) => {
      const y = f32(f32(r - cyg) * ky);
      for (let j = 0; j < st.gw; j++) {
        const x = f32(f32(j - cxg) * kx);
        arr[2 * j] = rint32(f32((x * ca - y * sa) * scale + 160) * 65536);
        arr[2 * j + 1] = rint32(f32((x * sa + y * ca) * scale + 100) * 65536);
      }
    };
    for (let L = 0; L < 6; L++) {
      const ph = st.ph[L];
      const scale = f32((Math.sin(a) * 0.5 + 2.0) * (ph * 0.03125));
      const q = f32(ph * (1 / 256));
      const g = f32(Math.sin(f32(q * 0.9 * q + q * 2.24)) * 0.7);
      for (let k = 0; k < 256; k++) tbl[k] = ftol(k * g) & 255;
      let cur = st.rowA, nxt = st.rowB;
      vertRow(cur, 0, scale);
      for (let i = 0; i < cellsY; i++) {
        vertRow(nxt, i + 1, scale);
        for (let j = 0; j < cellsX; j++) cell(D, i * 8 * W + 8 * j, W, cur, nxt, j, tex, tbl);
        const t = cur; cur = nxt; nxt = t;
      }
    }
  },
});

// 8x8 cell filler (0x59244). T = top corner row, Bt = bottom corner row (arrays of [u,v] int32 pairs), j = cell column.
function cell(D, dst, W, T, Bt, j, tex, tbl) {
  const tl = 2 * j, tr = tl + 2;
  let u0 = T[tl], v0 = T[tl + 1];
  let du = (T[tr] - T[tl]) >> 3, dv = (T[tr + 1] - T[tl + 1]) >> 3;
  const rdu = (Bt[tl] - T[tl]) >> 3, rdv = (Bt[tl + 1] - T[tl + 1]) >> 3;
  const ddu = ((((Bt[tr] - Bt[tl]) >> 3) - du) >> 3), ddv = ((((Bt[tr + 1] - Bt[tl + 1]) >> 3) - dv) >> 3);
  for (let r = 0; r < 8; r++) {
    let bl = (u0 >> 16) & 255, bh = (v0 >> 16) & 255;
    let esi = (u0 << 16) >>> 0, ebp = (v0 << 16) >>> 0;
    const ecxHi = (du << 16) >>> 0;                     // ecx = du<<16 | cl (cl = last written pixel)
    const dl = (du >> 16) & 255, dh = (dv >> 16) & 255;
    const edx = (((dv << 16) >>> 0) | (dh << 8) | dl) >>> 0;
    let cl = 0, texel = tex[(bh << 8) | bl], p = dst + r * W;
    for (let k = 0; k < 8; k++, p++) {
      let s = esi + ecxHi + cl; esi = s >>> 0; const c1 = s > 0xffffffff ? 1 : 0;
      bl = (bl + dl + c1) & 255;
      const al = tbl[texel], old = D[p];
      s = ebp + edx; ebp = s >>> 0; const c2 = s > 0xffffffff ? 1 : 0;
      bh = (bh + dh + c2) & 255;
      const sum = al + old; cl = sum > 255 ? 255 : sum;
      texel = tex[(bh << 8) | bl];
      D[p] = cl;
    }
    u0 = (u0 + rdu) | 0; v0 = (v0 + rdv) | 0; du = (du + ddu) | 0; dv = (dv + ddv) | 0;
  }
}

// ------------------------------------------------------------------------------------------------
// parasite   (script: `parasite pa1 {SCREEN3} {SCREEN3} {som.png}`, 32 bit 320x200 only)
// ------------------------------------------------------------------------------------------------
// 16 wobbling vertical bands per scanline.  For every scanline y the 16 left edges X[j] are
//   X[j] = trunc( 40*sin(y*K1[j] + e*K2[j]) * sin(0.01*y + e*K4[j]) + 40*j ),   e = 0.01 * (frame - first frame)
// and the bands are painted from the right (j = 15) to the left.  A band shows one row of the 256x256 8-bit picture
// som.png (row (37*j + y + 40*e) & 255) stretched over its width; the brightness depends on the band width
// (wide bands are dark): colour = palette[texel] * cos^3((1 - L/256) * pi/2) / 64 * 256, L = min(255, 32 * 255 / width).
// Left of the last band the line is cleared to black.   Original: 0x1969f (frame) + 0x59190 (band filler, self-modifying).
// K1/K2/K4 are random numbers drawn once at init with the C runtime rand() (LCG 0x41c64e6d, seed 1: parasite is the
// first user of rand() in the demo; the sequence was checked against the values found in the original's memory).
const PAR_K3 = f32(0.01);
let parTabs = null;                       // K1,K2,K4 : 16 floats each, drawn from the engine's rand() (LCG seed 1, nothing used it before)
function parasiteRand() {
  let seed = 1; const rnd = () => { seed = (Math.imul(seed, 0x41c64e6d) + 0x3039) >>> 0; return (seed >>> 16) & 0x7fff; };
  const K1 = new Float32Array(16), K2 = new Float32Array(16), K4 = new Float32Array(16);
  for (let j = 0; j < 16; j++) {
    K1[j] = (rnd() / 32767) * 0.014 + 0.01; K2[j] = (rnd() / 32767) * 1.8 + 1.1; K4[j] = (rnd() / 32767) * 1.8 + 1.3;
    // original also stores K3 = 0.01f and consumes the three rand() calls in this order (0x193e1, 0x19410, 0x1944f)
  }
  return { K1, K2, K4 };
}
FX.register('parasite', {
  init(params, ev, ctx) {
    const out = ev.outputs[0];
    if (out && (out.w !== 320 || out.h !== 200 || out.bpp !== 32)) console.error('ParaSite: Output buffer must be 320x200x32');
    parTabs = parTabs || parasiteRand();
    const img = ctx.assets.image(params.trim().split(/\s+/)[0]);
    // g(L) = cos^3((1 - L/256) * 1.570795) / 64, colour channel = min(255, rint(256 * g * p)) with p = the 6 bit (VGA) palette value = png palette >> 2
    const g = new Float32Array(256);
    for (let L = 0; L < 256; L++) {
      const ang = f32(f32(1 - L * 0.00390625) * 1.570795), c = Math.cos(ang);
      g[L] = c * c * c * 0.015625;
    }
    return { t0: null, rgb: img.rgb, g, chan: new Uint8Array(256 * 256), have: new Uint8Array(256), X: new Int32Array(17) };
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0]; if (!out) return;
    const fr = f32(ctx.frame); if (st.t0 === null) st.t0 = fr;
    const e = f32(f32(fr - st.t0) * 0.01), { K1, K2, K4 } = parTabs, X = st.X, D = out.data, rgb = st.rgb;
    const base = ftol(e * 40.0);
    const chan = (L) => {                       // 256-entry channel -> byte table for brightness level L (lazy)
      const o = L << 8;
      if (!st.have[L]) {
        st.have[L] = 1; const g = st.g[L];
        for (let v = 0; v < 256; v++) {         // x87: (v*g + 1.5*2^44) rounded to 2^-19 first, then to 2^-8 when stored as double
          const r1 = rint((v >> 2) * g * 524288); const c = rint(r1 / 2048); st.chan[o + v] = c > 255 ? 255 : c;
        }
      }
      return o;
    };
    for (let y = 0; y < 200; y++) {
      for (let j = 0; j < 16; j++) {
        const s1 = Math.sin(y * K1[j] + e * K2[j]) * 40.0;
        X[j] = ftol(Math.sin(y * PAR_K3 + e * K4[j]) * s1 + j * 40.0);
      }
      X[16] = 0;
      let limit = 320; const row = y * 320;
      for (let j = 15; j >= 0; j--) {
        const xj = X[j]; if (xj >= limit) continue;
        const W = X[j + 1] - xj, rowIdx = ((j * 37 + y + base) & 255) << 8;
        let count, x0, pos0;
        if (xj >= 0) { count = limit - xj; x0 = xj; pos0 = rowIdx; } else { count = limit; x0 = 0; pos0 = (rowIdx - xj) & 0xffff; }
        if (count > 0) {
          // 0x59190: s = 255/W as 16.16 ; level from |s|*32 ; position advances by int(s) + carry of the fraction
          let S = 0, L = 0;
          if (W !== 0) { const sf = 255 / W; S = rint(sf * 65536) | 0; L = Math.min(255, rint(Math.abs(sf) * 65536) >> 11); }
          const ip = S >> 16, fp = (S << 16) >>> 0, co = chan(L);
          let esi = fp, cf = 0, pos = pos0 & 0xffff;
          const pos32 = pos0 & 0xffff;
          pos = pos32;
          const px = (p) => (p >= 0 && p < 65536 ? rgb[p] : 0);
          let t = px(pos);
          for (let k = 0; k < count; k++) {
            pos += ip + cf;
            D[row + x0 + k] = (st.chan[co + ((t >> 16) & 255)] << 16) | (st.chan[co + ((t >> 8) & 255)] << 8) | st.chan[co + (t & 255)];
            const sum = esi + fp; esi = sum >>> 0; cf = sum > 0xffffffff ? 1 : 0;
            t = px(pos);
          }
        }
        limit = xj > 0 ? xj : 0;
      }
      for (let x = 0; x < limit; x++) D[row + x] = 0;
    }
  },
});

// ================================================================================================
// Shared 3D triangle pipeline of echo4 / echo6 (original: 0x8a69a front end, 0x8a1fc clipper, 0x8985d rasteriser).
// Vertex = {x,y,z (camera space), u,v (texture coords), w (unused), sx,sy (screen, 16.16)}, floats are kept in float32.
// ================================================================================================
const SCR_C14 = f32(-0.625), SCR_C18 = f32(-0.390625);   // projection scale pushed by 0x599d0 -> 0x8963a (0xced14 / 0xced18)
export class Vtx {
  constructor() { this.f = new Float32Array(6); this.s = new Int32Array(2); }   // f = x,y,z,u,v,w   s = sx,sy
  set(x, y, z, u, v, w = 0) { const f = this.f; f[0] = x; f[1] = y; f[2] = z; f[3] = u; f[4] = v; f[5] = w; return this; }
  copy(o) { this.f.set(o.f); this.s.set(o.s); return this; }
}
const negz = (v) => v < 0 || Object.is(v, -0);
// 0x8a1fc: clip against the plane (x - z < 0 is "inside").  Returns the number of triangles (0,1,2) and the vertices in r.
// r = [esi, edi, edx, ecx]; nb / nc are the scratch vertices (ebx / ecx).
function clipPlane(r, nb, nc) {
  const [s, e, d] = r;
  const a = f32(s.f[0] - s.f[2]), b = f32(e.f[0] - e.f[2]), c = f32(d.f[0] - d.f[2]);
  const code = (negz(c) ? 4 : 0) | (negz(b) ? 2 : 0) | (negz(a) ? 1 : 0);
  if (code === 0) return 0;
  if (code === 7) return 1;
  let tB, tC, S = s, E = e, D = d;
  if (code === 1 || code === 6) { tB = a / (a - b); tC = a / (a - c); }
  else if (code === 2 || code === 5) { tB = b / (b - a); tC = b / (b - c); S = e; E = s; }
  else { tB = c / (c - b); tC = c / (c - a); S = d; D = s; }   // codes 3, 4
  for (const k of [0, 1, 2, 3, 4, 5]) {     // x y z u v w  (offsets 0 4 8 0x14 0x18 0x1c)
    nb.f[k] = S.f[k] * (1 - tB) + E.f[k] * tB;
    nc.f[k] = D.f[k] * tC + S.f[k] * (1 - tC);
  }
  r[0] = S; r[1] = E; r[2] = D;
  if (code === 3 || code === 5 || code === 6) { r[0] = nb; r[3] = nc; return 2; }   // quad -> (nb,edi,edx) + (nb,ecx,edx)
  r[1] = nb; r[2] = nc; return 1;                                                    // (esi, nb, nc)
}
// the four clip stages: 0x8a69a (x<z)  ->  0x8a633 (-x<z)  ->  0x8a5c8 (y<z, x/y swapped)  ->  0x8a3d1 (-y<z) -> rasteriser
const stageBuf = [0, 1, 2, 3].map(() => [new Vtx(), new Vtx()]);   // [nb (ebx), nc (ecx)] of every stage
const flipX = (v) => { v.f[0] = -v.f[0]; };
const swapXY = (v) => { const t = v.f[0]; v.f[0] = v.f[1]; v.f[1] = t; };
const tmpV = [new Vtx(), new Vtx(), new Vtx()];

function stage(n, s, e, d, ctx) {
  // n: 0 = 0x8a69a (no transform), 1 = 0x8a633 (flip x), 2 = 0x8a5c8 (swap x,y), 3 = 0x8a3d1 (flip x, then rasterise)
  if (n === 1 || n === 3) { flipX(s); flipX(e); flipX(d); }
  if (n === 2) { swapXY(s); swapXY(e); swapXY(d); }
  const [nb, nc] = stageBuf[n], r = [s, e, d, nc];
  const cnt = clipPlane(r, nb, nc);
  if (cnt >= 1) {
    if (n === 3) {
      if (cnt === 2) rasterTri(r[2], r[1], r[0], ctx);          // first triangle: (esi,edi,edx) -> args (edx, edi, esi)
      const t2 = cnt === 2 ? [r[0], r[3], r[2]] : [r[0], r[1], r[2]];
      rasterTri(t2[2], t2[1], t2[0], ctx);
    } else {
      const sv = [r[0], r[3], r[2]];
      if (cnt === 2) stage(n + 1, r[0], r[1], r[2], ctx);
      if (cnt === 2) stage(n + 1, sv[0], sv[1], sv[2], ctx); else stage(n + 1, r[0], r[1], r[2], ctx);
    }
  }
  if (n === 1 || n === 3) { flipX(s); flipX(e); flipX(d); }
  if (n === 2) { swapXY(s); swapXY(e); swapXY(d); }
}
/** Draw one additive, perspective-correct textured triangle into an 8 bit 320x200 buffer (0x8a69a, mode 0).
 *  ctx = { screen: Uint8Array(64000), tex: Uint8Array(65536) }.  dest += texel (byte wrap, no saturation). */
export function drawTri(v1, v2, v3, ctx) {
  if (negz(v1.f[2]) && negz(v2.f[2]) && negz(v3.f[2])) return;      // 0x8a6c2: all three behind the camera
  stage(0, v1, v2, v3, ctx);
}

// ---- rasteriser (0x8985d): sub-pixel accurate scanline triangle, u/z v/z 1/z interpolated, texel lookup every pixel
// with a perspective correction every 8 pixels.  Globals of the original (0xcedb4 .. 0xcef14) are kept as locals.
const rpw = (x) => { // "fadd 1.5*2^60; fstp qword; low dword": x87 rounds to 1/8 (64 bit mantissa) then to a multiple of 256
  const r1 = rint(x * 8) / 8; return rint(r1 / 256) | 0; };
const INV8 = [0, 1, 0.5, f32(1 / 3), 0.25, f32(0.2), f32(1 / 6), f32(1 / 7)];   // table 0xced90 (entry 0 is 0)
const rv = [new Vtx(), new Vtx(), new Vtx(), new Vtx()];                         // copies of the three vertices + the pseudo vertex 0xcedfc
function edgeSetup(E, Tsx, osx, osy, F, T, withAttr, G) {          // 0x89665 (attributes) / 0x8982d (x only)
  const s = (osx / osy) * 65536;
  E.sl = f32(s); E.si = rint(s) | 0;
  E.x = rint(F * s + Tsx) | 0;
  if (!withAttr) return;
  const ip = E.si >> 16, xoff = f32((E.sl * F - (E.x & 0xffff)) / 65536);
  const one = (gx, gy, ta) => {
    const step = ip * gx + gy, us = (F * gy + ta) + xoff * gx;
    return [f32(step), f32(us + gx), f32(step + gx)];       // step, cur, step2
  };
  [E.su, E.cu, E.su2] = one(G.gxu, G.gyu, T.u);
  [E.sv, E.cv, E.sv2] = one(G.gxv, G.gyv, T.v);
  [E.sz, E.cz, E.sz2] = one(G.gxz, G.gyz, T.z);
}
const eL = {}, eR = {};
function rasterTri(p8, pC, p10, ctx) {
  const screen = ctx.screen, tex = ctx.tex, SW = 320;
  let esi = rv[0].copy(p8), edi = rv[1].copy(pC), ebx = rv[2].copy(p10);
  for (const v of [esi, edi, ebx]) {                         // perspective projection (see SCR_C14/18) and u/z, v/z, 1/z
    const rz = 16777216 / v.f[2];
    v.s[0] = rint(rz * v.f[1] * SCR_C14 + 0xa00000) | 0;      // screen x from field 1 (after the clip stages: -x), 160 px per unit
    v.s[1] = rint(rz * v.f[0] * SCR_C18 + 0x640000) | 0;      // screen y from field 0 (-y), 100 px per unit
    const inv = 1 / v.f[2];
    v.f[2] = inv; v.f[3] = v.f[3] * inv; v.f[4] = v.f[4] * inv;
  }
  let t;
  if (esi.s[1] > edi.s[1]) { t = esi; esi = edi; edi = t; }
  if (edi.s[1] > ebx.s[1]) { t = edi; edi = ebx; ebx = t; if (esi.s[1] > edi.s[1]) { t = esi; esi = edi; edi = t; } }
  let rowBase = (esi.s[1] >> 16) * SW;
  // absolute mid vertex (pseudo vertex 0xcedfc) and bottom y
  const M = { z: edi.f[2], sx: edi.s[0], sy: edi.s[1], u: edi.f[3], v: edi.f[4] }, botY = ebx.s[1];
  const rel = (a, b) => { a.s[0] = (a.s[0] - b.s[0]) | 0; a.s[1] = (a.s[1] - b.s[1]) | 0; a.f[2] = a.f[2] - b.f[2]; a.f[3] = a.f[3] - b.f[3]; a.f[4] = a.f[4] - b.f[4]; };
  rel(ebx, esi); rel(edi, esi);
  const dxm = edi.s[0], dym = edi.s[1], dxb = ebx.s[0], dyb = ebx.s[1];
  const det = dxm * dyb - dym * dxb, area = f32(det);
  if (det === 0) return;
  const k = 65536 / det, Dxm = dxm * k, Dym = dym * k, Dxb = dxb * k, Dyb = dyb * k;
  const gr = (am, ab) => [f32(am * Dyb - ab * Dym), f32(ab * Dxm - am * Dxb)];
  const G = {}; [G.gxu, G.gyu] = gr(edi.f[3], ebx.f[3]); [G.gxv, G.gyv] = gr(edi.f[4], ebx.f[4]); [G.gxz, G.gyz] = gr(edi.f[2], ebx.f[2]);
  const g8u = f32(G.gxu * 8), g8v = f32(G.gxv * 8), g8z = f32(G.gxz * 8);
  let F = ((~esi.s[1]) & 0xffff) / 65536;                   // [0xcee20]
  const Fm = ((~M.sy) & 0xffff) / 65536;                    // [0xcee24]
  const TOP = { u: esi.f[3], v: esi.f[4], z: esi.f[2] }, MID = { u: M.u, v: M.v, z: M.z };
  const neg = (area < 0 || Object.is(area, -0));
  let yStart, yEnd, seg2;                                   // seg2: 0 none, 1 = det>=0 style, 2 = det<0 style
  const midRel = { s0: 0 };
  if (!neg) {
    if (ebx.s[1] === 0) return;
    edgeSetup(eL, esi.s[0], ebx.s[0], ebx.s[1], F, TOP, true, G);                 // long edge = left, with attributes
    if (edi.s[1] !== 0) { edgeSetup(eR, esi.s[0], edi.s[0], edi.s[1], F, null, false, G); seg2 = 1; yStart = esi.s[1]; yEnd = M.sy; }
    else {
      rel(ebx, edi); F = Fm; if (ebx.s[1] === 0) return;
      edgeSetup(eR, M.sx, ebx.s[0], ebx.s[1], F, null, false, G); seg2 = 0; yStart = M.sy; yEnd = botY;
    }
  } else {
    if (ebx.s[1] === 0) return;
    edgeSetup(eR, esi.s[0], ebx.s[0], ebx.s[1], F, null, false, G);               // long edge = right (x only)
    if (edi.s[1] !== 0) { edgeSetup(eL, esi.s[0], edi.s[0], edi.s[1], F, TOP, true, G); seg2 = 2; yStart = esi.s[1]; yEnd = M.sy; }
    else {
      rel(ebx, edi); F = Fm; if (ebx.s[1] === 0) return;
      edgeSetup(eL, M.sx, ebx.s[0], ebx.s[1], F, MID, true, G); seg2 = 0; yStart = M.sy; yEnd = botY;
    }
  }
  for (;;) {
    let y = yStart >> 16, rows = Math.min(yEnd >> 16, 200) - y;
    while (rows > 0) {
      if (y >= 0) drawRow();
      // 0x8a14f: step the edges to the next scanline
      const nx = (eL.x + eL.si) | 0, carry = ((nx & 0xffff) < (eL.si & 0xffff)) ? 1 : 0;
      eL.x = nx; eR.x = (eR.x + eR.si) | 0;
      eL.cu = f32(eL.cu + (carry ? eL.su2 : eL.su)); eL.cv = f32(eL.cv + (carry ? eL.sv2 : eL.sv)); eL.cz = f32(eL.cz + (carry ? eL.sz2 : eL.sz));
      rowBase += SW; y++; rows--;
    }
    if (seg2 === 0) break;
    // second segment: bottom relative to the mid vertex, new short edge starting at the mid vertex
    rel(ebx, edi); F = Fm; if (ebx.s[1] === 0) return;
    if (seg2 === 1) edgeSetup(eR, M.sx, ebx.s[0], ebx.s[1], F, null, false, G);
    else edgeSetup(eL, M.sx, ebx.s[0], ebx.s[1], F, MID, true, G);
    seg2 = 0; yStart = M.sy; yEnd = botY;
  }
  function drawRow() {
    let L = eL.x >> 16, R = eR.x >> 16;
    if (R > 320) R = 320;
    if (L < 0) L = 0;                                       // (the original does not advance the attributes here)
    const cnt = R - L; if (cnt <= 0) return;
    const R0 = 1 / eL.cz, n = cnt - 1, m = n & 7;
    let groups = n >> 3, pos = rowBase + L + m;
    let Zm = f32(eL.cz + m * G.gxz), Um = f32(eL.cu + m * G.gxu), Vm = f32(eL.cv + m * G.gxv);
    const u0 = eL.cu * R0, v0 = eL.cv * R0, u0f = f32(u0), v0f = f32(v0);
    const Us = rpw(u0), Vs = rpw(v0);
    let R1 = 1 / Zm;
    const um = Um * R1, vm = Vm * R1;
    let prevU = rpw(um), prevV = rpw(vm);
    const stepV = rpw((vm - v0f) * INV8[m]), stepU = rpw((um - u0f) * INV8[m]);
    Um = f32(Um + g8u); Vm = f32(Vm + g8v); Zm = f32(Zm + g8z);
    let Rr = 1 / Zm;
    let eax = (((stepU << 16) | (stepV & 0xffff)) >>> 0);
    let b = (((Us << 16) | (Vs & 0xffff)) >>> 0);
    let q = pos - m;
    for (let i = 0; i <= m; i++, q++) {
      const edx = ((b >>> 24) | (((b >>> 8) & 255) << 8));
      b = (b + eax) >>> 0;
      screen[q] = (screen[q] + tex[edx]) & 255;
    }
    q = pos + 1;
    while (groups-- > 0) {
      const UE = rpw(Um * Rr), VE = rpw(Vm * Rr);
      Um = f32(Um + g8u); Vm = f32(Vm + g8v); Zm = f32(Zm + g8z); Rr = 1 / Zm;
      const du = (UE - prevU) | 0, dv = (VE - prevV) | 0;
      b = (((prevU << 16) | (prevV & 0xffff)) >>> 0);
      eax = ((((du >> 3) << 16) | ((dv >> 3) & 0xffff)) >>> 0);
      prevU = UE; prevV = VE;
      for (let i = 0; i < 8; i++, q++) {
        b = (b + eax) >>> 0;
        const edx = ((b >>> 24) | (((b >>> 8) & 255) << 8));
        screen[q] = (screen[q] + tex[edx]) & 255;
      }
    }
  }
}

// ================================================================================================
// 3x4 float matrix helpers of the original 3D library (0x8b570 .. 0x8ba34); m = Float32Array(12), rows of 4.
// ================================================================================================
const mIdent = (m) => { m.fill(0); m[0] = m[5] = m[10] = 1; };
// rotate two rows: a' = c*a - s*b ; b' = s*a + c*b   (rows given by their start index)
function mRot(m, ra, rb, ang) {
  const s = f32(Math.sin(ang)), c = f32(Math.cos(ang));
  for (let j = 0; j < 4; j++) {
    const a = m[ra + j], b = m[rb + j];
    m[ra + j] = c * a - s * b; m[rb + j] = s * a + c * b;
  }
}
const mRotX = (m, a) => mRot(m, 4, 8, a);     // 0x8b834
const mRotY = (m, a) => mRot(m, 8, 0, a);     // 0x8b734   (rows 0 and 2)
const mRotZ = (m, a) => mRot(m, 0, 4, a);     // 0x8b634   (rows 0 and 1)
const mScale = (m, sx, sy, sz) => { for (let j = 0; j < 4; j++) { m[j] *= sx; m[4 + j] *= sy; m[8 + j] *= sz; } };   // 0x8b5a8
const mTrans = (m, x, y, z) => { m[3] += x; m[7] += y; m[11] += z; };                                              // 0x8b938
// 0x8ba34: out = M * in for n vertices (stride 13 floats = 0x34 bytes, x y z at 0..2)
function mXform(m, vin, vout, n) {
  for (let i = 0, o = 0; i < n; i++, o += 13) {
    const x = vin[o], y = vin[o + 1], z = vin[o + 2];
    vout[o] = m[1] * y + m[0] * x + m[2] * z + m[3];
    vout[o + 1] = m[5] * y + m[4] * x + m[6] * z + m[7];
    vout[o + 2] = m[9] * y + m[8] * x + m[10] * z + m[11];
  }
}

// ================================================================================================
// echo4 / echo6 common parts
// ================================================================================================
const lcgNext = (st) => { st.s = (Math.imul(st.s, 0x41c64e6d) + 0x3039) >>> 0; return (st.s >>> 16) & 0x7fff; };   // Watcom rand()
/** 0x8b51c/0x8b380: 2500 soft round blobs (radius R, height A) added at random places of a 256x256 8 bit texture. */
function blobTexture(seed, R, A) {
  const tex = new Uint8Array(65536), g = { s: seed >>> 0 };
  for (let n = 0; n < 2500; n++) {
    const be = lcgNext(g) % 255, ae = lcgNext(g) % 255;         // centre y, centre x
    const x0 = ftol(ae - R - 1), x1 = ftol(ae + R + 1), y0 = ftol(be - R - 1), y1 = ftol(be + R + 1);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const d = f32(Math.sqrt((x - ae) * (x - ae) + (y - be) * (y - be)));
      if (d >= R) continue;
      const i = (x + (y << 8)) & 0xffff, v = ftol(A * (Math.cos(d * Math.PI / R) * 0.5 + 0.5) + tex[i]);
      tex[i] = v > 255 ? 255 : v;
    }
  }
  return tex;
}
/** 0x35e2c + 0x35e82: recursive glow smear, first along the rows then down the columns: out = sat(in + T[previous out]),
 *  T[k] = round(k * gain) (the table is built by accumulating `gain`, like the FPU loop). */
function smear(buf, gain) {
  const T = new Uint8Array(256); let acc = 0;
  for (let k = 0; k < 256; k++, acc += gain) T[k] = rint(acc) & 255;
  for (let y = 0; y < 200; y++) { let p = 0; for (let x = y * 320, e = x + 320; x < e; x++) { const v = buf[x] + T[p]; p = v > 255 ? 255 : v; buf[x] = p; } }
  for (let x = 0; x < 320; x++) { let p = 0; for (let i = x; i < 64000; i += 320) { const v = buf[i] + T[p]; p = v > 255 ? 255 : v; buf[i] = p; } }
}

// ================================================================================================
// echo4   (script: `echo4 plani {SCREEN8} {SCREEN8} {Frame*0.8}`)
// ================================================================================================
// A "cage" of 3 x 6 translucent-looking planes (quads at +-100,+-60,+-20 along each axis, 36 triangles) is rotated by the
// accumulated value of the expression and every triangle is drawn *additively* (dest += texel, byte wrap) with a perspective
// correct texture mapper into the 8 bit buffer; the texture is 2500 random soft blobs.  Afterwards the whole picture is
// smeared (each pixel gets 0.65 x the already smeared pixel on its left, then above it) which gives the glow trails.
// The expression is not used as a value: only its change since the previous frame (dt) matters.
const ECHO4_SEED = 1959454520;       // rand() state when the original built the texture (measured in the original run)
function echo4Geometry() {
  const vin = new Float32Array(72 * 13), faces = [];
  const K = 0.00085;
  let nv = 0;
  for (let g = 0; g < 3; g++) for (let k = -5; k <= 5; k += 2) {
    const c = k * 20, corners = [[-100, 100], [100, 100], [100, -100], [-100, -100]], base = nv;
    for (const [a, b] of corners) {
      const xyz = g === 0 ? [a, b, c] : g === 1 ? [a, c, b] : [c, a, b];
      vin.set(xyz, nv * 13); nv++;
    }
    const uv = corners.map(([a, b]) => [f32((a + c) * K), f32((b - c) * K)]);
    faces.push({ v: [base, base + 1, base + 2], uv: [uv[0], uv[1], uv[2]] }, { v: [base, base + 2, base + 3], uv: [uv[0], uv[2], uv[3]] });
  }
  return { vin, faces, nv };
}
FX.register('echo4', {
  init(params) {
    const geo = echo4Geometry();
    return { expr: compileExpr(params.trim().split(/\s+/)[0]), t0: null, prev: 0, A: 0, tex: blobTexture(ECHO4_SEED, 5, 6), geo,
      vout: new Float32Array(72 * 13), M: new Float32Array(12), verts: [new Vtx(), new Vtx(), new Vtx()] };
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0]; if (!out || out.w !== 320 || out.h !== 200 || out.bpp !== 8) return;
    const fr = f32(ctx.frame); if (st.t0 === null) st.t0 = fr;
    const dt = f32(f32(st.expr(f32(fr - st.t0))) - st.prev); st.prev = f32(st.prev + dt);
    echo4Frame(st, dt, out.data);
  },
});
export function echo4Frame(st, dt, screen) {
  const M = st.M, { vin, faces } = st.geo, vout = st.vout;
  st.A = f32(dt * 0.00225 + st.A);
  mIdent(M); mRotX(M, st.A); mRotY(M, f32(st.A * 1.1)); mRotZ(M, f32(st.A * 0.8));
  mScale(M, 3.5, f32(4.55), 3.5); mTrans(M, 0, 0, 500);
  mXform(M, vin, vout, 72);
  SCROLL.a2c = f32(dt * 3000 + SCROLL.a2c);
  const ctx = { screen, tex: st.tex }, [a, b, c] = st.verts;
  for (const f of faces) {
    const [i, j, k] = f.v, zs = vout[i * 13 + 2] + vout[j * 13 + 2] + vout[k * 13 + 2];
    const bucket = ftol(zs * 0.2);
    if (bucket >= 4096) continue;
    [a, b, c].forEach((v, n) => { const o = f.v[n] * 13; v.set(vout[o], vout[o + 1], vout[o + 2], f.uv[n][0] * 65536 * 256 + SCROLL.a2c, f.uv[n][1] * 65536 * 256); });
    drawTri(a, b, c, ctx);
  }
  smear(screen, f32(0.65));
}

// ================================================================================================
// echo6: a wobbling sphere.  Mesh = octahedron (radius 300) subdivided 4 times (0x8b2e0 / 0x8b218 / 0x8b060):
// every edge midpoint is pushed back onto the sphere with integer arithmetic.
// ================================================================================================
const OCT_V = [[0, 0, 300], [0, 300, 0], [300, 0, 0], [0, -300, 0], [-300, 0, 0], [0, 0, -300]];
const OCT_F = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [4, 5, 1], [3, 5, 4], [2, 5, 3], [1, 5, 2]];
export function sphereMesh(level) {
  const verts = OCT_V.map((v) => v.slice()), index = new Map(verts.map((v, i) => [v.join(','), i])), faces = [];
  const mid = (i, j) => {
    const a = verts[i], b = verts[j];
    const m = [0, 1, 2].map((k) => ftol((a[k] + b[k]) / 2));           // sum + (sum<0) >> 1  == truncating division
    const L = ftol(Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2])), r = 1 / L;
    const p = m.map((c) => ftol(c * 300 * r));
    const key = p.join(','); let n = index.get(key);
    if (n === undefined) { n = verts.length; verts.push(p); index.set(key, n); }
    return n;
  };
  const sub = (a, b, c, lvl) => {
    if (lvl === 0) { faces.push([a, b, c]); return; }
    const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
    sub(a, mab, mca, lvl - 1); sub(mab, b, mbc, lvl - 1); sub(mca, mbc, c, lvl - 1); sub(mab, mbc, mca, lvl - 1);
  };
  for (const [a, b, c] of OCT_F) sub(a, b, c, level);
  return { verts, faces };
}

const ECHO6_SEED = 4046262688;       // rand() state when the original built the texture (measured in the original run)
const SCROLL = { a2c: 0 };           // texture scroll global 0xc8a2c, shared by echo4 and echo6 (echo6 runs first in the demo)
FX.register('echo6', {
  init(params) {
    const mesh = sphereMesh(4), n = mesh.verts.length;
    const v0 = new Float32Array(n * 13); mesh.verts.forEach((v, i) => v0.set(v, i * 13));
    const uv = mesh.faces.map((f) => f.map((i) => [f32(mesh.verts[i][0] * 0.0019), f32(mesh.verts[i][1] * 0.0019)]));
    return { expr: compileExpr(params.trim().split(/\s+/)[0]), t0: null, prev: 0, A: 0, P: 0, tex: blobTexture(ECHO6_SEED, 5, 12), mesh, uv, v0,
      w: new Float32Array(n * 13), vt: new Float32Array(n * 13), M: new Float32Array(12), verts: [new Vtx(), new Vtx(), new Vtx()] };
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0]; if (!out || out.w !== 320 || out.h !== 200 || out.bpp !== 8) return;
    const fr = f32(ctx.frame); if (st.t0 === null) st.t0 = fr;
    const dt = f32(f32(st.expr(f32(fr - st.t0))) - st.prev); st.prev = f32(st.prev + dt);
    echo6Frame(st, dt, out.data);
  },
});
export function echo6Frame(st, dt, screen) {
  const { M, v0, w, vt, mesh } = st, n = mesh.verts.length;
  st.A = f32(dt * 0.00525 + st.A);
  mIdent(M); mRotX(M, st.A); mRotY(M, f32(st.A * 1.1)); mRotZ(M, f32(st.A * 0.8)); mScale(M, 2, f32(0.7), 1);
  mXform(M, v0, w, n);
  // radial wobble: every vertex is scaled by a sum of three sines of its own (integer) coordinates
  st.P = f32(dt * f32(0.01) * 1.8 + st.P);
  const P = st.P, P2 = f32(P * 0.8), P3 = f32(P * 1.3), D = f32(40.84070587158203);
  for (let i = 0, o = 0; i < n; i++, o += 13) {
    const t1 = Math.sin(((v0[o] | 0) << 16 >> 16) / D + P) * 0.3 + 0.6666666666666666;
    const t2 = Math.sin(((v0[o + 1] | 0) << 16 >> 16) / D + P2) * 0.3 + 0.6666666666666666 + t1;
    const s = f32(Math.sin(((v0[o + 2] | 0) << 16 >> 16) / D + P3) * 0.3 + 0.6666666666666666 + t2);
    w[o] *= s; w[o + 1] *= s; w[o + 2] *= s;
  }
  mIdent(M); mRotX(M, f32(Math.sin(st.A) * 0.8)); mRotY(M, f32(Math.sin(st.A * 1.1) * 0.8)); mRotZ(M, 0); mTrans(M, 0, 0, 1000);
  mXform(M, w, vt, n);
  SCROLL.a2c = f32(SCROLL.a2c + dt * 10000 * 0.4);
  const ctx = { screen, tex: st.tex }, [a, b, c] = st.verts;
  mesh.faces.forEach((f, fi) => {
    const o1 = f[0] * 13, o2 = f[1] * 13, o3 = f[2] * 13;                    // C = v1, A = v2, B = v3 (camera space, eye at the origin)
    const Cx = vt[o1], Cy = vt[o1 + 1], Cz = vt[o1 + 2], Ax = vt[o2], Ay = vt[o2 + 1], Az = vt[o2 + 2], Bx = vt[o3], By = vt[o3 + 1], Bz = vt[o3 + 2];
    const t1 = Ay * Bz - Az * By, t2 = Ax * Bz - Az * Bx, t3 = Ay * Bx - Ax * By;
    if (t3 * Cz > t1 * Cx - t2 * Cy) return;                                // back face
    const bucket = ftol((Cz + Az + Bz) * 0.2);
    if (bucket >= 4096) return;
    const q = st.uv[fi];
    [a, b, c].forEach((v, k) => { const o = f[k] * 13; v.set(vt[o], vt[o + 1], vt[o + 2], q[k][0] * 65536 * 256 + SCROLL.a2c, q[k][1] * 65536 * 256); });
    drawTri(a, b, c, ctx);
  });
}
export const _test = { mIdent, mRotX, mRotY, mRotZ, mScale, mTrans, mXform, blobTexture, smear, lcgNext, echo4Geometry, sphereMesh, SCROLL };
