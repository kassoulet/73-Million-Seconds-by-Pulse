// raster.js - triangle fillers (software, typed arrays, no allocation per call).
// The original has ~25 handwritten scanline fillers (0x612fc ... 0x74f88) selected by bpp / shading mode; the demo only uses
//  * 0x612fc  "beam" filler  : adds +k at the left edge and -k at the right edge of each scanline of a 16 bit buffer (prefix summed later)
//  * 0x6f75c  textured filler: affine u,v, alpha blended into a 32 bit buffer (lwotr = alpha)
// Edge rounding follows the original: an edge x is converted with (x*65536 + 0xfff0) >> 16, i.e. ceil(x - 1/16).

const q = (x) => Math.ceil(x - 0.0625);

// scratch (module level -> no per-call allocation)
const X = new Float64Array(3), Y = new Float64Array(3), U = new Float64Array(3), V = new Float64Array(3);

// The original fillers (0x6f75c / 0x612fc) test edge deltas against 0x3cb851ec (0.0225, an x87
// denormal guard) and jump to a path that drives the scanline along the OTHER axis (major-axis
// switch). Here the port flips to the x-major walker once the triangle's y-extent drops under a
// pixel, which is the same set of near-horizontal slivers.
const MAJOR_EPS = 1.0;
// 0x3cb851ec: the original's x87 denormal guard for a near-zero edge delta. When a triangle's top
// sub-edge is flatter than this, dividing by it blows up (xr extrapolates far off screen, painting a
// stray scanline); use the other, well-conditioned edge instead.
const EDGE_EPS = 0.0225;

function order(ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
  X[0] = ax; Y[0] = ay; U[0] = au; V[0] = av; X[1] = bx; Y[1] = by; U[1] = bu; V[1] = bv; X[2] = cx; Y[2] = cy; U[2] = cu; V[2] = cv;
  let t;
  if (Y[0] > Y[1]) { t = X[0]; X[0] = X[1]; X[1] = t; t = Y[0]; Y[0] = Y[1]; Y[1] = t; t = U[0]; U[0] = U[1]; U[1] = t; t = V[0]; V[0] = V[1]; V[1] = t; }
  if (Y[1] > Y[2]) { t = X[1]; X[1] = X[2]; X[2] = t; t = Y[1]; Y[1] = Y[2]; Y[2] = t; t = U[1]; U[1] = U[2]; U[2] = t; t = V[1]; V[1] = V[2]; V[2] = t; }
  if (Y[0] > Y[1]) { t = X[0]; X[0] = X[1]; X[1] = t; t = Y[0]; Y[0] = Y[1]; Y[1] = t; t = U[0]; U[0] = U[1]; U[1] = t; t = V[0]; V[0] = V[1]; V[1] = t; }
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t); // keep an edge parameter inside its segment
/** generic scanline walker: calls span(y, xl, ul, vl, xr, ur, vr) with xl<=xr for every covered row */
function walk(H, span) {
  const y0 = Y[0], y2 = Y[2];
  if (y2 - y0 < 1e-9) return;
  if (y2 - y0 < MAJOR_EPS) { walkX(H, span); return; } // near-horizontal: drive by x (major axis)
  let ys = Math.max(0, q(y0)); const ye = Math.min(H - 1, q(y2) - 1 + (q(y2) === y2 ? 0 : 0));
  const hl = y2 - y0;
  for (let y = ys; y <= ye; y++) {
    if (y < y0 - 0.0625) continue;
    const yy = y + 0.0625;                               // q() samples rows at y + 1/16: evaluate the edges there too, or thin triangles leave 1-row cracks
    const tl = clamp01((yy - y0) / hl);                   // long edge 0 -> 2
    const xl = X[0] + (X[2] - X[0]) * tl, ul = U[0] + (U[2] - U[0]) * tl, vl = V[0] + (V[2] - V[0]) * tl;
    let xr, ur, vr;
    const dtop = Y[1] - y0;
    if (yy < Y[1] && dtop > EDGE_EPS) { const ts = clamp01((yy - y0) / dtop); xr = X[0] + (X[1] - X[0]) * ts; ur = U[0] + (U[1] - U[0]) * ts; vr = V[0] + (V[1] - V[0]) * ts; }
    else { const d = y2 - Y[1]; const ts = clamp01(d > 1e-9 ? (yy - Y[1]) / d : 0); xr = X[1] + (X[2] - X[1]) * ts; ur = U[1] + (U[2] - U[1]) * ts; vr = V[1] + (V[2] - V[1]) * ts; }
    if (xl <= xr) span(y, xl, ul, vl, xr, ur, vr); else span(y, xr, ur, vr, xl, ul, vl);
  }
}

/** x-major fallback for near-horizontal triangles: one vertical slice per column, u,v from the plane. */
function walkX(H, span) {
  if (Y[2] - Y[0] < 1e-9) return;
  const xmin = Math.min(X[0], X[1], X[2]), xmax = Math.max(X[0], X[1], X[2]);
  const d = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
  if (Math.abs(d) < 1e-12) return;
  const udx = ((U[1] - U[0]) * (Y[2] - Y[0]) - (U[2] - U[0]) * (Y[1] - Y[0])) / d;
  const udy = ((X[1] - X[0]) * (U[2] - U[0]) - (X[2] - X[0]) * (U[1] - U[0])) / d;
  const vdx = ((V[1] - V[0]) * (Y[2] - Y[0]) - (V[2] - V[0]) * (Y[1] - Y[0])) / d;
  const vdy = ((X[1] - X[0]) * (V[2] - V[0]) - (X[2] - X[0]) * (V[1] - V[0])) / d;
  const E = [[X[0], Y[0], X[1], Y[1]], [X[1], Y[1], X[2], Y[2]], [X[2], Y[2], X[0], Y[0]]];
  const x0 = Math.max(0, q(xmin)), x1 = Math.min(_W, q(xmax));
  for (let x = x0; x < x1; x++) {
    const xm = x + 0.5; let lo = Infinity, hi = -Infinity;
    for (const [ax, ay, bx, by] of E) {
      if ((xm >= ax && xm <= bx) || (xm >= bx && xm <= ax)) { const yy = ax === bx ? ay : ay + (by - ay) * (xm - ax) / (bx - ax); if (yy < lo) lo = yy; if (yy > hi) hi = yy; }
    }
    if (lo > hi) continue;
    for (let y = Math.max(0, q(lo)); y <= Math.min(H - 1, q(hi) - 1); y++) {
      const u = U[0] + udx * (xm - X[0]) + udy * (y + 0.5 - Y[0]);
      const v = V[0] + vdx * (xm - X[0]) + vdy * (y + 0.5 - Y[0]);
      span(y, x, u, v, x + 1, u + udx, v + vdx);
    }
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
const _dc = new Float64Array(6);
/** texcoord fixups the original setup (0x27b7c) applies to every vertex before the filler:
 *  coord >= 255 -> coord - 255 (0xb8ef8 = -255.0); and when all three v are equal, one v is
 *  decremented by 1 (0xb8f10/14/18 = -1.0) so the texture has a non-zero gradient. */
export function degen(u0, v0, u1, v1, u2, v2) {
  if (u0 > 255) u0 -= 255; if (v0 > 255) v0 -= 255;
  if (u1 > 255) u1 -= 255; if (v1 > 255) v1 -= 255;
  if (u2 > 255) u2 -= 255; if (v2 > 255) v2 -= 255;
  if (v0 === v1 && v1 === v2) {
    if (u0 === u1) v2 -= 1;
    if (u0 === u2) v1 -= 1;
    if (u2 === u1) v0 -= 1;
  }
  _dc[0] = u0; _dc[1] = v0; _dc[2] = u1; _dc[3] = v1; _dc[4] = u2; _dc[5] = v2;
  return _dc;
}
/** textured, alpha blended triangle into a 32 bit buffer. tex = Uint32Array(256*256) 0x00RRGGBB, alpha 0..255 */
export function triTex32(dst, W, H, tex, alpha, ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
  const t = degen(au, av, bu, bv, cu, cv);
  order(ax, ay, t[0], t[1], bx, by, t[2], t[3], cx, cy, t[4], t[5]);
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
  const t = degen(au, av, bu, bv, cu, cv);
  order(ax, ay, t[0], t[1], bx, by, t[2], t[3], cx, cy, t[4], t[5]); _dst = dst; _W = W; _tex = tex; walk(H, spanTex8);
}

function spanDelta(y, xl, ul, vl, xr) {
  let x0 = q(xl), x1 = q(xr); if (x1 <= x0) return; if (x0 < 0) x0 = 0; if (x0 >= _W) return; if (x1 > _W) x1 = _W; if (x1 <= x0) return;
  const p = y * _W; _dst[p + x0] += _k; if (x1 < _W) _dst[p + x1] -= _k; // x1 == W: the original writes into the padding / next row start; dropped
}
/** beam filler (0x612fc): dst is a Uint16Array; adds k at the left edge and subtracts it at the right edge of every scanline */
export function triDelta16(dst, W, H, k, ax, ay, bx, by, cx, cy) {
  order(ax, ay, 0, 0, bx, by, 0, 0, cx, cy, 0, 0); _dst = dst; _W = W; _k = k; walk(H, spanDelta);
}
