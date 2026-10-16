// raster.js - triangle fillers (software, typed arrays, no allocation per call).
// The original has ~25 handwritten scanline fillers (0x612fc ... 0x74f88) selected by bpp / shading mode; the demo only uses
//  * 0x612fc  "beam" filler  : adds +k at the left edge and -k at the right edge of each scanline of a 16 bit buffer (prefix summed later)
//  * 0x6f75c  textured filler: affine u,v, alpha blended into a 32 bit buffer (lwotr = alpha)
// Edge rounding follows the original: an edge x is converted with (x*65536 + 0xfff0) >> 16, i.e. ceil(x - 1/16).

const q = (x) => Math.ceil(x - 0.0625);

// scratch (module level -> no per-call allocation)
const X = new Float64Array(3), Y = new Float64Array(3), U = new Float64Array(3), V = new Float64Array(3);

function order(ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
  X[0] = ax; Y[0] = ay; U[0] = au; V[0] = av; X[1] = bx; Y[1] = by; U[1] = bu; V[1] = bv; X[2] = cx; Y[2] = cy; U[2] = cu; V[2] = cv;
  let t;
  if (Y[0] > Y[1]) { t = X[0]; X[0] = X[1]; X[1] = t; t = Y[0]; Y[0] = Y[1]; Y[1] = t; t = U[0]; U[0] = U[1]; U[1] = t; t = V[0]; V[0] = V[1]; V[1] = t; }
  if (Y[1] > Y[2]) { t = X[1]; X[1] = X[2]; X[2] = t; t = Y[1]; Y[1] = Y[2]; Y[2] = t; t = U[1]; U[1] = U[2]; U[2] = t; t = V[1]; V[1] = V[2]; V[2] = t; }
  if (Y[0] > Y[1]) { t = X[0]; X[0] = X[1]; X[1] = t; t = Y[0]; Y[0] = Y[1]; Y[1] = t; t = U[0]; U[0] = U[1]; U[1] = t; t = V[0]; V[0] = V[1]; V[1] = t; }
}

/** generic scanline walker: calls span(y, xl, ul, vl, xr, ur, vr) with xl<=xr for every covered row */
function walk(H, span) {
  const y0 = Y[0], y2 = Y[2];
  if (y2 - y0 < 1e-9) return;
  let ys = Math.max(0, q(y0)); const ye = Math.min(H - 1, q(y2) - 1 + (q(y2) === y2 ? 0 : 0));
  const hl = y2 - y0;
  for (let y = ys; y <= ye; y++) {
    if (y < y0 - 0.0625) continue;
    const tl = (y - y0) / hl;                             // long edge 0 -> 2
    const xl = X[0] + (X[2] - X[0]) * tl, ul = U[0] + (U[2] - U[0]) * tl, vl = V[0] + (V[2] - V[0]) * tl;
    let xr, ur, vr;
    if (y < Y[1]) { const d = Y[1] - y0; const ts = d > 1e-9 ? (y - y0) / d : 0; xr = X[0] + (X[1] - X[0]) * ts; ur = U[0] + (U[1] - U[0]) * ts; vr = V[0] + (V[1] - V[0]) * ts; }
    else { const d = y2 - Y[1]; const ts = d > 1e-9 ? (y - Y[1]) / d : 0; xr = X[1] + (X[2] - X[1]) * ts; ur = U[1] + (U[2] - U[1]) * ts; vr = V[1] + (V[2] - V[1]) * ts; }
    if (xl <= xr) span(y, xl, ul, vl, xr, ur, vr); else span(y, xr, ur, vr, xl, ul, vl);
  }
}

let _dst = null, _W = 0, _tex = null, _a = 0, _k = 0, _H = 0, _pal = null;

function spanTex32(y, xl, ul, vl, xr, ur, vr) {
  let x0 = q(xl), x1 = q(xr); if (x0 < 0) x0 = 0; if (x1 > _W) x1 = _W; if (x1 <= x0) return;
  const n = xr - xl, du = n > 1e-9 ? (ur - ul) / n : 0, dv = n > 1e-9 ? (vr - vl) / n : 0;
  let u = ul + (x0 - xl) * du, v = vl + (x0 - xl) * dv;
  const dst = _dst, tex = _tex, a = _a, ia = 256 - a;
  for (let p = y * _W + x0, e = y * _W + x1; p < e; p++, u += du, v += dv) {
    const c = tex[((v & 255) << 8) | (u & 255)], d = dst[p];
    if (a === 256) { dst[p] = c; continue; }
    const r = (((c >> 16) & 255) * a + ((d >> 16) & 255) * ia) >> 8, g = (((c >> 8) & 255) * a + ((d >> 8) & 255) * ia) >> 8, b = ((c & 255) * a + (d & 255) * ia) >> 8;
    dst[p] = (r << 16) | (g << 8) | b;
  }
}
/** textured, alpha blended triangle into a 32 bit buffer. tex = Uint32Array(256*256) 0x00RRGGBB, alpha 0..255 */
export function triTex32(dst, W, H, tex, alpha, ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
  order(ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv);
  _dst = dst; _W = W; _tex = tex; _a = alpha + (alpha >> 7); walk(H, spanTex32);
}

function spanTex8(y, xl, ul, vl, xr, ur, vr) {
  let x0 = q(xl), x1 = q(xr); if (x0 < 0) x0 = 0; if (x1 > _W) x1 = _W; if (x1 <= x0) return;
  const n = xr - xl, du = n > 1e-9 ? (ur - ul) / n : 0, dv = n > 1e-9 ? (vr - vl) / n : 0;
  let u = ul + (x0 - xl) * du, v = vl + (x0 - xl) * dv;
  const dst = _dst, tex = _tex;
  for (let p = y * _W + x0, e = y * _W + x1; p < e; p++, u += du, v += dv) dst[p] = tex[((v & 255) << 8) | (u & 255)];
}
/** textured triangle into an 8 bit (palette index) buffer, tex = Uint8Array(65536) */
export function triTex8(dst, W, H, tex, ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
  order(ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv); _dst = dst; _W = W; _tex = tex; walk(H, spanTex8);
}

function spanDelta(y, xl, ul, vl, xr) {
  let x0 = q(xl), x1 = q(xr); if (x1 <= x0) return; if (x0 < 0) x0 = 0; if (x0 >= _W) return; if (x1 > _W) x1 = _W; if (x1 <= x0) return;
  const p = y * _W; _dst[p + x0] += _k; if (x1 < _W) _dst[p + x1] -= _k; // x1 == W: the original writes into the padding / next row start; dropped
}
/** beam filler (0x612fc): dst is a Uint16Array; adds k at the left edge and subtracts it at the right edge of every scanline */
export function triDelta16(dst, W, H, k, ax, ay, bx, by, cx, cy) {
  order(ax, ay, 0, 0, bx, by, 0, 0, cx, cy, 0, 0); _dst = dst; _W = W; _k = k; walk(H, spanDelta);
}
