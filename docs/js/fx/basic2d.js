// basic2d.js - the "simple" 2D effects of the 73ms engine, ported from the disassembly of 73MS.EXE.
// fillbuffer blit surfcopy palette fade xfade blend interpolator lowpass matrix colordistort
// Every routine below mirrors an inner loop of the original (addresses in comments are file addresses of 73MS.EXE).
// Buffer roles in the original event: inputs = ev+0x30,+0x34 ; output = ev+0x40.
import { FX, compileExpr } from '../core.js';

const f32 = Math.fround;
const _views = new WeakMap();
/** Byte view of a typed array (cached, so no per frame allocation). */
function bytes(a) {
  let v = _views.get(a);
  if (!v) { v = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); _views.set(a, v); }
  return v;
}
/** x87 FISTP after the engine's "ftol" helper (0x1ed6a): rounding mode forced to truncation. */
const ftol = Math.trunc;

// ---------------------------------------------------------------------------------------------
// blit / surfcopy  (0xfd79 -> 0x75ab -> generic surface converter 0x39719)
// ---------------------------------------------------------------------------------------------
export function blitBuf(src, dst) {
  if (src === dst) return;
  if (src.bpp === dst.bpp) { dst.data.set(src.data); return; }
  convert(src, dst);
}
// ponytail: the original goes through the video library's generic converter (vtable call, uses the destination
// surface palette), which can not be run in the emulator (no real surfaces). Cross-depth rules below are an
// ASSUMPTION: 8 bit = grey ramp, 32->8 = luma.  Same-depth blits are exact memcpy.
function convert(src, dst) {
  const n = src.w * src.h, s = src.data, d = dst.data, sb = src.bpp, db = dst.bpp;
  const rgb = (i) => sb === 32 ? s[i] : sb === 8 ? s[i] * 0x10101 : (((s[i] & 0xf800) << 8) | ((s[i] & 0x7e0) << 5) | ((s[i] & 31) << 3));
  for (let i = 0; i < n; i++) {
    const c = rgb(i);
    if (db === 8) d[i] = sb === 8 ? c & 255 : ((((c >> 16) & 255) * 77 + ((c >> 8) & 255) * 151 + (c & 255) * 28) >> 8);
    else if (db === 32) d[i] = c;
    else d[i] = ((c >> 8) & 0xf800) | ((c >> 5) & 0x7e0) | ((c >> 3) & 31);
  }
}

FX.register('blit', {
  init() { return null; },
  run(st, ev) { blitBuf(ev.inputs[0], ev.outputs[0]); },
});
FX.register('surfcopy', FX.get('blit'));

// ---------------------------------------------------------------------------------------------
// fillbuffer: memset(out, 0, w*h*bpp/8)   (0xe09d) - the parameter is parsed but ignored
// ---------------------------------------------------------------------------------------------
FX.register('fillbuffer', {
  init() { return null; },
  run(st, ev) { ev.outputs[0].data.fill(0); },
});

// ---------------------------------------------------------------------------------------------
// palette: 8 bit index -> 32 bit RGB through a VGA (6 bit) palette file   (0xed48, loop 0x81ad)
// ---------------------------------------------------------------------------------------------
FX.register('palette', {
  init(params, ev, ctx) {
    const p = ctx.assets.bin(params.trim().toLowerCase());
    const lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++) // 0x81bd..0x81cd: (r<<16|g<<8|b) << 2  => each 6 bit component * 4
      lut[i] = ((p[i * 3] << 16) | (p[i * 3 + 1] << 8) | p[i * 3 + 2]) << 2;
    return { lut };
  },
  run(st, ev) {
    const s = ev.inputs[0].data, d = ev.outputs[0].data, lut = st.lut, n = s.length;
    if (ev.outputs[0].bpp === 16) { // 0x815a variant (not used by the script): RGB565 out
      for (let i = 0; i < n; i++) { const c = lut[s[i]]; d[i] = ((c >> 8) & 0xf800) | ((c >> 5) & 0x7e0) | ((c >> 3) & 31); }
      return;
    }
    for (let i = 0; i < n; i++) d[i] = lut[s[i]];
  },
});

// ---------------------------------------------------------------------------------------------
// fade: out = in*(1-a) + colour*a, a = trunc(255*expr(Frame)).   Tables at [0xdc284]/[0xdc28c]:
//   T284[a][v] = (v*(256-a))>>8      T28c[a][v] = (v*a)>>8      (checked against the emulator memory)
// params: "r g b expr"
// ---------------------------------------------------------------------------------------------
function parseFade(params) {
  const t = params.trim().split(/\s+/);
  return { r: f32(parseFloat(t[0])), g: f32(parseFloat(t[1])), b: f32(parseFloat(t[2])), fn: compileExpr(t.slice(3).join('')) };
}
FX.register('fade', {
  init(params) { return parseFade(params); },
  run(st, ev) {
    const i = ev.inputs[0], o = ev.outputs[0];
    const a = ftol(f32(st.fn(ev.local)) * 255);
    if (a <= 0) { blitBuf(i, o); return; }
    const A = a > 255 ? 255 : a, IA = 256 - A;
    const s = i.data, d = o.data, n = s.length;
    if (i.bpp === 32) { // 0x51ee0 + 0x51f28: three table lookups per pixel, constant colour pre-added
      const cr = (ftol(st.r * 255) * A) >> 8, cg = (ftol(st.g * 255) * A) >> 8, cb = (ftol(st.b * 255) * A) >> 8;
      for (let k = 0; k < n; k++) {
        const p = s[k];
        d[k] = ((((((p >> 16) & 255) * IA) >> 8) + cr) << 16) | ((((((p >> 8) & 255) * IA) >> 8) + cg) << 8) | ((((p & 255) * IA) >> 8) + cb);
      }
    } else if (i.bpp === 8) { // 0x51d88 + 0x51db1: palette index fade towards index round(85*(r+g+b))
      const ci = ftol(st.g * 85 + st.r * 85 + st.b * 85), c = (ci & 255) * A >> 8;
      for (let k = 0; k < n; k++) d[k] = ((s[k] * IA) >> 8) + c;
    } else { // 16 bit (0x51e1c/0x51e53): approximated, not used by the script
      const cr = (ftol(st.r * 255) * A) >> 8, cg = (ftol(st.g * 255) * A) >> 8, cb = (ftol(st.b * 255) * A) >> 8;
      for (let k = 0; k < n; k++) {
        const p = s[k];
        const r = ((((p >> 8) & 0xf8) * IA) >> 8) + cr, g = ((((p >> 3) & 0xfc) * IA) >> 8) + cg, b = ((((p << 3) & 0xf8) * IA) >> 8) + cb;
        d[k] = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
      }
    }
  },
});

// ---------------------------------------------------------------------------------------------
// xfade: out = in0*a + in1*(1-a)  (32 bit only), a = trunc(255*expr).  a<=0 -> copy in1, a>=255 -> copy in0.
// per byte: (in0*a >> 8) + (in1*(256-a) >> 8)   (0x51f84 patches the tables, 0x51fad is the loop)
// ---------------------------------------------------------------------------------------------
FX.register('xfade', {
  init(params) { return { fn: compileExpr(params.trim()) }; },
  run(st, ev) {
    const i0 = ev.inputs[0], i1 = ev.inputs[1], o = ev.outputs[0];
    const a = ftol(f32(st.fn(ev.local)) * 255);
    if (a <= 0) { blitBuf(i1, o); return; }
    if (a >= 255) { blitBuf(i0, o); return; }
    const s0 = bytes(i0.data), s1 = bytes(i1.data), d = bytes(o.data), n = s0.length, ia = 256 - a;
    for (let k = 0; k < n; k += 4) { // only the 3 colour bytes are written, the 4th byte of the output is left alone (as in 0x51fad)
      d[k] = ((s0[k] * a) >> 8) + ((s1[k] * ia) >> 8);
      d[k + 1] = ((s0[k + 1] * a) >> 8) + ((s1[k + 1] * ia) >> 8);
      d[k + 2] = ((s0[k + 2] * a) >> 8) + ((s1[k + 2] * ia) >> 8);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// blend: the whole 64000-pixel buffer is combined bytewise with MMX saturated arithmetic (0xb37a8.. / 0xb3808)
//  mode 1: paddusb   out = min(255, in0+in1)         mode 2: colour key (in1 if its RGB != 0 else in0)
//  mode 3: psubusb   out = max(0, in0-in1)           mode 11: min(255, 2*min(255,in0+in1))
//  mode 22: colour key against the first pixel of in1   mode 33: (original bug) all zero
// ---------------------------------------------------------------------------------------------
FX.register('blend', {
  init(params) { return { mode: parseInt(params, 10) || 0 }; },
  run(st, ev) {
    const a = ev.inputs[0], b = ev.inputs[1] || a, o = ev.outputs[0];
    const mode = st.mode;
    const n32 = (a.w * a.h * a.bpp) >> 5;
    if (mode === 2 || mode === 22) { // 0xb382a / 0xb3861 (dword loop, key test on the 24 colour bits)
      const A = new Uint32Array(a.data.buffer, a.data.byteOffset, n32), Bb = new Uint32Array(b.data.buffer, b.data.byteOffset, n32), O = new Uint32Array(o.data.buffer, o.data.byteOffset, n32);
      const key = mode === 22 ? (Bb[0] & 0xffffff) : 0;
      for (let k = 0; k < n32; k++) { const v = Bb[k] & 0xffffff; O[k] = v === key ? A[k] : v; }
      return;
    }
    const s0 = bytes(a.data), s1 = bytes(b.data), d = bytes(o.data), n = (a.w * a.h * a.bpp) >> 3;
    if (mode === 1) for (let k = 0; k < n; k++) { const v = s0[k] + s1[k]; d[k] = v > 255 ? 255 : v; }
    else if (mode === 3) for (let k = 0; k < n; k++) { const v = s0[k] - s1[k]; d[k] = v < 0 ? 0 : v; }
    else if (mode === 11) for (let k = 0; k < n; k++) { let v = s0[k] + s1[k]; if (v > 255) v = 255; v += v; d[k] = v > 255 ? 255 : v; }
    else if (mode === 33) d.fill(0, 0, n);
  },
});

// ---------------------------------------------------------------------------------------------
// interpolator: SCREEN16 holds signed 16 bit *deltas* written by the 3D rasteriser (loadscene ... i);
// every row is integrated: acc += delta, out = acc, but 255 when acc leaves 0..255  (loop 0x57b8c)
// ---------------------------------------------------------------------------------------------
FX.register('interpolator', {
  init() { return null; },
  run(st, ev) {
    const i = ev.inputs[0], o = ev.outputs[0];
    const s = new Int16Array(i.data.buffer, i.data.byteOffset, i.data.length), d = o.data, w = i.w, h = i.h;
    for (let y = 0, p = 0; y < h; y++) {
      let acc = 0;
      for (let x = 0; x < w; x++, p++) { acc += s[p]; d[p] = (acc >>> 0) > 255 ? 255 : acc; }
    }
  },
});

// ---------------------------------------------------------------------------------------------
// lowpass: separable one pole IIR filter, forward then backward along rows, then along columns.
// s = expr (0..1); a = trunc(128*s); a>=128 -> plain copy.  MMX path of the original (CPUID MMX flag set):
//   32 bit  rows 0xb4978 (word arithmetic y += ((x-y)*a)>>7 per channel), columns 0xb48d8
//   8 bit   rows 0xb4a1c (byte table T[d]=trunc(d*s), y += T[x-y]), columns 0xb4838 (4 columns per movd)
// The original's backward pass reads one pixel (32 bit) / four pixels (8 bit) past the end of the temp
// row, which shifts the filtered image left by 1 / 4 pixels; the temp buffer is shared, we keep it too.
// ---------------------------------------------------------------------------------------------
const TMP = new Uint8Array(0x800); // the asm module's scratch row at 0xb3e38

function vpass(db, off0, stride, n, a) { // 4 byte lanes, n rows, in place (0xb4838 / 0xb48d8)
  for (let k = 0; k < 4; k++) {
    let y = db[off0 + k]; TMP[k] = y;
    for (let r = 1, p = off0 + stride + k; r < n; r++, p += stride) { y += ((db[p] - y) * a) >> 7; TMP[4 * r + k] = y; }
    let z = y;
    for (let r = n - 1, p = off0 + stride * (n - 1) + k; r >= 0; r--, p -= stride) { z += ((TMP[4 * r + k] - z) * a) >> 7; db[p] = z; }
  }
}
function hrow32(sb, so, db, dobase, w, a) { // 0xb4978
  for (let k = 0; k < 4; k++) {
    let y = sb[so + k]; TMP[k] = y;
    for (let i = 1; i < w; i++) { y += ((sb[so + 4 * i + k] - y) * a) >> 7; TMP[4 * i + k] = y; }
    let z = y; // backward pass starts one dword too far: TMP[w] is whatever follows the row (0)
    for (let j = w - 1; j >= 0; j--) { z += ((TMP[4 * (j + 1) + k] - z) * a) >> 7; db[dobase + 4 * j + k] = z; }
  }
}
function hrow8(sb, so, db, dobase, w, T) { // 0xb4a1c
  let prev = sb[so];
  for (let i = 0; i < w; i++) { prev = (prev + T[sb[so + i] - prev + 256]) & 255; TMP[i] = prev; }
  prev = TMP[w - 1];
  for (let g = w; g > 0; g -= 4) // 4 pixels per step, highest first; output = filtered TMP[x+4]
    for (let k = 3; k >= 0; k--) { prev = (prev + T[TMP[g + k] - prev + 256]) & 255; db[dobase + g - 4 + k] = prev; }
}

FX.register('lowpass', {
  init(params) { return { fn: compileExpr(params.trim()), T: new Int8Array(512), lastS: NaN }; },
  run(st, ev) {
    const i = ev.inputs[0], o = ev.outputs[0];
    const s = f32(st.fn(ev.local)), a = ftol(s * 128);
    if (a >= 128) { blitBuf(i, o); return; }
    const w = i.w, h = i.h;
    if (i.bpp === 8) {
      if (s !== st.lastS) { st.lastS = s; for (let k = 0; k < 512; k++) st.T[k] = ftol((k - 256) * s); } // 0x12117 loop
      const sb = i.data, db = o.data;
      for (let y = 0; y < h; y++) hrow8(sb, y * w, db, y * w, w, st.T);
      for (let x = 0; x < w; x += 4) vpass(db, x, w, h, a);
    } else if (i.bpp === 32) {
      const sb = bytes(i.data), db = bytes(o.data);
      for (let y = 0; y < h; y++) hrow32(sb, y * w * 4, db, y * w * 4, w, a);
      for (let x = 0; x < w; x++) vpass(db, x * 4, w * 4, h, a);
    } else console.warn('lowpass: unsupported depth', i.bpp);
  },
});

// ---------------------------------------------------------------------------------------------
// matrix: 3x3 convolution on 8 bit buffers, done with 9 byte tables (T_k[v] = trunc(v*m_k) & 255) and byte wraparound adds
// out = T0[tl]+T1[t]+T2[tr]+T3[l]+T4[0](bug: centre pixel is never used)+T5[r]+T6[bl]+T7[b]+T8[br] + trunc(255*m9)   (mod 256), interior pixels only (0x5276a)
// ---------------------------------------------------------------------------------------------
FX.register('matrix', {
  init(params) {
    const m = params.trim().split(/\s+/).map((x) => f32(parseFloat(x)));
    const T = new Uint8Array(9 * 256);
    for (let k = 0; k < 9; k++) for (let v = 0; v < 256; v++) T[k * 256 + v] = ftol(v * m[k]) & 255; // 0x128e2
    return { T, bias: ftol(m[9] * 255) & 255 };
  },
  run(st, ev) {
    const i = ev.inputs[0], o = ev.outputs[0], w = i.w, h = i.h, T = st.T, bias = st.bias, s = i.data, d = o.data;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, p = y * w + 1; x < w - 1; x++, p++) {
        d[p] = (T[s[p - w - 1]] + T[256 + s[p - w]] + T[512 + s[p - w + 1]] + T[768 + s[p - 1]] + /* centre: original does 'xor edx,edx' after loading it => T4[0] = 0 */ T[1024] +
          T[1280 + s[p + 1]] + T[1536 + s[p + w - 1]] + T[1792 + s[p + w]] + T[2048 + s[p + w + 1]] + bias) & 255;
      }
    }
  },
});

// ---------------------------------------------------------------------------------------------
// colordistort (alias colormap): out[i] = file[in[i]]  - a 256 byte lookup table (m2.bin)  (0xeeaa)
// ---------------------------------------------------------------------------------------------
FX.register('colordistort', {
  init(params, ev, ctx) { return { lut: ctx.assets.bin(params.trim().toLowerCase()) }; },
  run(st, ev) { const s = ev.inputs[0].data, d = ev.outputs[0].data, l = st.lut; for (let k = 0; k < s.length; k++) d[k] = l[s[k]]; },
});
FX.register('colormap', FX.get('colordistort'));
