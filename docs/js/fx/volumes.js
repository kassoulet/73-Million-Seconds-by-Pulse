// volumes.js - "blob.c" effects of 73ms.exe: 16x16x16 float scalar fields (volume3D, clearvolume, copyvolume,
// metaballs, morphvolume, addvolume, subvolume, mulvolume, fadevolume, plasma1volume), a marching-cubes
// polygoniser (marchingcubes) and a volume -> additive sprite renderer (volumesprites).
// Everything is ported from the original code at 0x16000-0x19400 (effect functions), 0x57c98 (marching cubes,
// hand-written asm) and 0x58f04 (sprite blitter); see docs/notes/volumes-*.html.
import { FX } from '../core.js';

const N = 16, NN = 4096;                 // volume = 16^3 floats, index = x + 16*y + 256*z (the original: 0x4000 bytes)
const f32 = Math.fround;
const volsOf = (ctx) => ctx.__volumes || (ctx.__volumes = new Map());

function findVolume(ctx, name, who) {
  const v = volsOf(ctx).get(name);
  if (!v) throw new Error(who + ': Volume not found (' + name + ')');   // original: puts(msg) + exit
  return v;
}
const words = (s) => s.trim().split(/\s+/);

// ---------------------------------------------------------------- volume3D / clear / copy
FX.register('volume3D', {
  init(params, ev, ctx) {
    const p = words(params), name = p[0], data = new Float32Array(NN);
    if (p.length > 1) { const b = ctx.assets.bin(p[1]); data.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + NN * 4))); }
    const vols = volsOf(ctx); if (vols.size >= 32) throw new Error('Too many volumes!!!');
    vols.set(name, data); return { name, data };
  },
  run() {},                                   // the original run function is empty
  free(st, ev, ctx) { volsOf(ctx).delete(st.name); },
});
FX.register('clearvolume', {
  init(params, ev, ctx) { return { v: findVolume(ctx, words(params)[0], 'ClearVolume') }; },
  run(st) { st.v.fill(0); },                  // 0x17387: 0x400 * 16 bytes of zero
});
FX.register('copyvolume', {
  init(params, ev, ctx) { const p = words(params); return { dst: findVolume(ctx, p[0], 'CopyVolume dest'), src: findVolume(ctx, p[1], 'CopyVolume src') }; },
  run(st) { st.dst.set(st.src); },
});

// ---------------------------------------------------------------- arithmetic on whole volumes (0x5836c .. 0x5848e: x87, 4 floats per iteration)
function binop(name, who, f) {
  FX.register(name, {
    init(params, ev, ctx) { const p = words(params); return { d: findVolume(ctx, p[0], who), a: findVolume(ctx, p[1], who), b: findVolume(ctx, p[2], who) }; },
    run(st) { const { d, a, b } = st; for (let i = 0; i < NN; i++) d[i] = f(a[i], b[i]); },
  });
}
binop('addvolume', 'AddVolume', (a, b) => a + b);
binop('subvolume', 'SubVolume', (a, b) => a - b);
binop('mulvolume', 'MulVolume', (a, b) => a * b);
FX.register('fadevolume', {                    // fadevolume dst src factor-expression : dst = src * f(Frame)
  init(params, ev, ctx) { const p = words(params); return { d: findVolume(ctx, p[0], 'FadeVolume'), s: findVolume(ctx, p[1], 'FadeVolume'), f: ctx.expr(p[2]) }; },
  run(st, ev) { const f = f32(st.f(ev.local)), { d, s } = st; for (let i = 0; i < NN; i++) d[i] = s[i] * f; },
});
FX.register('morphvolume', {                   // morphvolume dst A B t : dst = A*t + B*(1-t)   (0x5843c)
  init(params, ev, ctx) { const p = words(params); return { d: findVolume(ctx, p[0], 'MorphVolume'), a: findVolume(ctx, p[1], 'MorphVolume'), b: findVolume(ctx, p[2], 'MorphVolume'), f: ctx.expr(p[3]) }; },
  run(st, ev) { const t = f32(st.f(ev.local)), u = 1 - t, { d, a, b } = st; for (let i = 0; i < NN; i++) d[i] = a[i] * t + b[i] * u; },
});

// ---------------------------------------------------------------- plasma1volume (0x5848f)
// table of distances to the volume centre, built once by the init function (0x18ac2): sqrt(dx^2+dy^2+dz^2), dx = x - 7.5
const PLASMA_TAB = new Float32Array(NN);
for (let i = 0; i < NN; i++) {
  const x = (i & 15) - 7.5, y = ((i >> 4) & 15) - 7.5, z = ((i >> 8) & 15) - 7.5;
  PLASMA_TAB[i] = Math.sqrt(x * x + y * y + z * z);
}
/** v = a + b*sin(dist + phase); computed for one octant and mirrored (the original does the same: 8x8x8 sines, then copies). */
export function plasma(vol, a, b, phase) {
  for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = f32(a + b * Math.sin(PLASMA_TAB[x + 16 * y + 256 * z] + phase));
    const x2 = 15 - x, y2 = 15 - y, z2 = 15 - z;
    vol[x + 16 * y + 256 * z] = v; vol[x2 + 16 * y + 256 * z] = v; vol[x + 16 * y2 + 256 * z] = v; vol[x2 + 16 * y2 + 256 * z] = v;
    vol[x + 16 * y + 256 * z2] = v; vol[x2 + 16 * y + 256 * z2] = v; vol[x + 16 * y2 + 256 * z2] = v; vol[x2 + 16 * y2 + 256 * z2] = v;
  }
}
FX.register('plasma1volume', {
  init(params, ev, ctx) { const p = words(params); return { v: findVolume(ctx, p[0], 'Plasma1Volume'), a: ctx.expr(p[1]), b: ctx.expr(p[2]) }; },
  run(st, ev) { const F = f32(ev.local); plasma(st.v, f32(st.a(F)), f32(st.b(F)), F * 0.02); },
});

// ---------------------------------------------------------------- metaballs (0x175e9 init, 0x178c6 run, 0x169a8 = ball renderer)
/** Add one metaball to the volume. Grid point i sits at (i-8)*0.25; falloff is the quartic (A d2 + B) d2 + C, zero (value and slope) at d2=R^2. */
export function addBall(vol, X, Y, Z, R, C, dx2, dy2, dz2) {
  X = f32(X); Y = f32(Y); Z = f32(Z); R = f32(R); C = f32(C);
  const R2 = f32(R * R), A = f32(C / (R2 * R2)), B = f32(-2 * C / R2), CC = C;
  for (let i = 0; i < N; i++) {
    const p = (i - 8) * 0.25;
    let d = f32(p - X); dx2[i] = f32(d * d); d = f32(p - Y); dy2[i] = f32(d * d); d = f32(p - Z); dz2[i] = f32(d * d);
  }
  let x0 = 0, y0 = 0, z0 = 0, x1 = 15, y1 = 15, z1 = 15;               // bounding box of the sphere of radius R in grid units
  while (x0 !== N && dx2[x0] > R2) x0++;
  while (y0 !== N && dy2[y0] > R2) y0++;
  while (z0 !== N && dz2[z0] > R2) z0++;
  while (x1 !== -1 && dx2[x1] > R2) x1--;
  while (y1 !== -1 && dy2[y1] > R2) y1--;
  while (z1 !== -1 && dz2[z1] > R2) z1--;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {      // note: y outer, z inner, like the original
    const t = f32(dy2[y] + dz2[z]);
    if (t > R2) continue;
    let p = x0 + 16 * y + 256 * z;
    for (let x = x0; x <= x1; x++, p++) {
      const d2 = f32(dx2[x] + t);
      if (d2 < R2) vol[p] += (d2 * A + B) * d2 + CC;                    // Float32Array store = fstp dword
    }
  }
}
const _dx = new Float32Array(N), _dy = new Float32Array(N), _dz = new Float32Array(N);
FX.register('metaballs', {
  init(params, ev, ctx) {
    const p = words(params), v = findVolume(ctx, p[0], 'MetaBalls');
    const lines = ctx.assets.text(p[1]).split(/\r?\n/), balls = [];
    for (let i = 0; i < 8; i++) {                                       // exactly 8 lines are read: "X Y Z R C" (expressions of Frame)
      const t = words(lines[i] || '@');
      if (t.length < 5) throw new Error('MetaBalls: Wrong param at config file line ' + (i + 2));
      balls.push(t.slice(0, 5).map((e) => ctx.expr(e)));
    }
    return { v, balls };
  },
  run(st, ev) {
    const F = ev.local;
    for (const [x, y, z, r, c] of st.balls) addBall(st.v, x(F), y(F), z(F), r(F), c(F), _dx, _dy, _dz);   // adds to the volume (no clear)
  },
});

// ---------------------------------------------------------------- marching cubes (0x57c98)
// 1/sqrt mantissa table, generated at startup by 0x6258: entry i = top 8 bits of the mantissa of 1/sqrt(0.5 + i/256)
const RSQRT = new Uint8Array(128);
{
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < 128; i++) { u[0] = 0x3f000000 | (i << 17); const r = new Float32Array([1 / Math.sqrt(f[0])]); u[0] = new Uint32Array(r.buffer)[0]; RSQRT[i] = ((u[0] + 0x2000) >>> 15) & 0xff; }
  RSQRT[0x40] = 0xff;
}
// Triangle table (data segment 0xbda50: 256 cases x up to 5 triangles, terminated by -1) = the classic Lorensen/Bourke marching cubes
// table in cube-edge numbers 0..11. Case = (inside-mask of the upper z plane << 4) | mask of the lower plane.
const TRI_EDGES = ';038;091;138918;1b2;0381b2;9b2092;23828bb89;32a;02a80a;1092a3;12a1a99a8;31ba3b;01b0b88ba;30939aa9b;9b8ba8;487;403743;091874;491417713;1b2874;3743401b2;9b2920874;29b279237749;87432a;a74a42240;9108742a3;4a79a492a912;31b3ba748;1ba1a414074a;4879a09baa30;4a749a9ba;945;945038;045105;845853351;1b2945;3801b2459;5b2524420;25b352345384;9452a3;02a0a8459;0450512a3;2512852a8458;ba3b31945;45901881b8ba;5045a05baa30;5845b8ba8;987597;903935537;087071175;135375;987975b21;b21905503537;820852875b25;25b235375;75979832a;9759279022a7;2a3081187175;a12a71751;985875b31ba3;50759070a1b0a0b;a0ba30b05870507;a5b75a;b56;03856b;91056b;13818956b;156216;156162380;956960062;589528562382;2a3b56;a80a02b56;0912a356b;56b12992a9a8;6a3635531;0a805a01556a;36a063056095;6956a9a89;56b487;4034376b5;10956b874;b56179137749;621615487;152562340374;874950056062;793749392569296;32a748b56;56b4274022a7;0914872a356b;91292a9a474a56b;87435a31556a;5a156a1a074a0a4;095056063a36874;6956a949779a;b946b4;46b4b9038;b10b06604;8138618466b1;194142246;380192294246;042462;823842462;b94b46a32;0282a84b946b;32a0610466b1;6146b14182a181a;946963931a36;81a801a16941614;36a306046;684a86;76b7b88b9;03707b0b96b7;b7617b187108;b76b17137;162186198876;296219697039793;708760620;723627;2a3b86b98876;2702a70796b797b;10818717b6b72a3;a12a71b16617;869876961a36163;019a76;70876030aa06;76a;7a6;380a67;091a67;891813a67;b2167a;1b238067a;20929b67a;67a23bb38b89;732672;780706602;267273091;126168189867;b67b71173;b671b7178180;0730b709b67b;7b678b89b;648a68;3a6360064;8a6864910;964936913a63;64868a21b;1b23a00a6064;48a4a609229b;b39b23934a63436;832824426;024426;109243264483;149124264;83181686461b;b01b60640;43648363b093b39;b4964b;4597a6;038459a67;5105047a6;a67843345351;945b217a6;67a1b2038459;7a65b44b2420;384345352b25a67;732726594;945068026678;326367105504;682678281458185;945b61167173;1b6167170807945;4b045b0b367b3b7;7b678b5b44b8;65969aa98;3a6036065059;08a0a50515a6;63a653513;1b29a598aa65;03a0a60695961b2;a58a65850b25052;63a65323bb35;598582526328;965906026;185108586328682;165261;1631b6368596869;b01b60905506;0835b6;b65;ab57a5;ab5a57803;57a5ab109;b57b7a918813;a21a17715;0381721577a2;95797292027a;7257a2529382928;2b5253357;802825857b52;91053b57332b;928912827b52725;153357;078017157;930953573;978579;54858bb8a;54050a5aba03;0918b48abb54;b4ab54a43914341;21525828a485;0a403a4a521a5a1;05209525a485a58;95423a;2b5325354348;52b542402;32b3b5358485091;52b542129924;854835315;054150;854835950053;954;47a4a99ab;03847997a9ab;1ab14a1047a4;34138414b7a4b4a;47a94a9a2921;94797a9a121a038;a47a24204;a47a24843342;2b9297273794;97b947b72807270;3b732b7b410b4b0;12b847;419471731;419471018817;430734;478;98bb8a;3903a9ab9;0b108b8ab;3b1ab3;1a219a98a;3903a919229a;0a28a0;3a2;2832b8b98;92b029;2832b808118b;12b;183981;019;083;';
// cube edge -> (edge array, dx,dy,dz) as packed by the table at 0xbda20 (array<<12 | dz<<8 | dy<<4 | dx); array 0/1/2 = edges along x/y/z
const EDGE_MAP = [0x0000, 0x1001, 0x0010, 0x1000, 0x0100, 0x1101, 0x0110, 0x1100, 0x2000, 0x2001, 0x2010, 0x2011];
// vertex slot code = array*4096 + dz*256 + dy*16 + dx, relative to the slot of the cell's lowest sample (x-1,y-1,z-1) = s-273
const TRI = TRI_EDGES.split(';').map((c) => Array.from(c, (ch) => { const m = EDGE_MAP[parseInt(ch, 12)]; return (m >> 12) * 4096 + ((m >> 8) & 15) * 256 + ((m >> 4) & 15) * 16 + (m & 15); }));
export const MC_TRI = TRI, MC_RSQRT = RSQRT;
const _f1 = new Float32Array(1), _i1 = new Int32Array(_f1.buffer), _u1 = new Uint32Array(_f1.buffer);
/** 1/sqrt(x) estimate: exponent halved by integer arithmetic, mantissa from a 128-entry table, then one Newton step (done by the caller). */
function rsqrtApprox(bits) {
  const idx = (bits >>> 17) & 0x7f, e = bits & 0x7f800000;
  _u1[0] = ((((0xbe000000 - e) >>> 1) & 0x7f800000) | (RSQRT[idx] << 15)) >>> 0;
  return _f1[0];
}

export class MarchingCubes {
  /** bbox = [xmin,ymin,zmin,xmax,ymax,zmax] of the object (obj+0xbc..0xd0). */
  constructor(bbox) {
    const [x0, y0, z0, x1, y1, z1] = bbox.map(f32);
    this.step = [f32((x1 - x0) / 15), f32((y1 - y0) / 15), f32((z1 - z0) / 15)]; this.min = [x0, y0, z0];
    this.pos = new Float32Array(3 * 3 * NN); this.nrm = new Float32Array(3 * 3 * NN);   // 3 arrays (x,y,z edges) of 4096 vertex slots
    this.out = new Uint32Array(15 * NN); this.nTri = 0;                                // generous: <= 5 triangles per cell
    this.faceN = new Float32Array(3 * 5 * NN);
    const [sx, sy, sz] = this.step;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {   // 0x5fc4: static components of the edge vertices
      const s = x + 16 * y + 256 * z, px = f32(x * sx + x0), py = f32(y * sy + y0), pz = f32(z * sz + z0);
      this.pos[3 * s + 1] = py; this.pos[3 * s + 2] = pz;                      // x-edge slot (x,y,z): y,z fixed
      this.pos[3 * (NN + s)] = px; this.pos[3 * (NN + s) + 2] = pz;            // y-edge slot
      this.pos[3 * (2 * NN + s)] = px; this.pos[3 * (2 * NN + s) + 1] = py;    // z-edge slot
    }
    this.mask = new Uint8Array(NN + 256); this._g1 = new Float64Array(3); this._g2 = new Float64Array(3);
  }
  /** central/one-sided gradient (x2 at the borders) of sample s=(x,y,z): returns -(dV) so it points out of the blob (0x581f2) */
  _grad(v, s, x, y, z, o) {
    o[0] = x === 0 ? (v[s] - v[s + 1]) * 2 : x === 15 ? (v[s - 1] - v[s]) * 2 : v[s - 1] - v[s + 1];
    o[1] = y === 0 ? (v[s] - v[s + 16]) * 2 : y === 15 ? (v[s - 16] - v[s]) * 2 : v[s - 16] - v[s + 16];
    o[2] = z === 0 ? (v[s] - v[s + 256]) * 2 : z === 15 ? (v[s - 256] - v[s]) * 2 : v[s - 256] - v[s + 256];
  }
  /** one crossing vertex: slot index k (array*4096+slot), t = fraction from sample s1 towards s0 along axis ax */
  _edge(v, s1, s0, ax, k, x, y, z, thr) {
    const v1 = v[s1], t = (v1 - thr) / (v1 - v[s0]);
    const g1 = this._g1, g2 = this._g2, st = ax === 0 ? 1 : ax === 1 ? 16 : 256;
    this._grad(v, s0, ax === 0 ? x - 1 : x, ax === 1 ? y - 1 : y, ax === 2 ? z - 1 : z, g1);
    this._grad(v, s1, x, y, z, g2);
    const gx = g2[0] - (g2[0] - g1[0]) * t, gy = g2[1] - (g2[1] - g1[1]) * t, gz = g2[2] - (g2[2] - g1[2]) * t;
    _f1[0] = gx * gx + gy * gy + gz * gz; const gg = _f1[0], r = rsqrtApprox(_i1[0]);   // |g|^2 is stored as float, its bits index the table
    const k2 = r * 0.5 * (3 - r * r * gg);                                             // one Newton-Raphson step
    const c = ax === 0 ? x : ax === 1 ? y : z, sp = this.step[ax];
    this.pos[3 * k + ax] = sp * c + (this.min[ax] - t * sp);
    this.nrm[3 * k] = gx * k2; this.nrm[3 * k + 1] = gy * k2; this.nrm[3 * k + 2] = gz * k2;
  }
  /** polygonise: vol = Float32Array(4096), thr = threshold. Fills this.out (3 vertex-slot indices per triangle), returns the triangle count. */
  run(vol, thr) {
    thr = f32(thr); _f1[0] = thr; const T = _i1[0];
    const vi = new Int32Array(vol.buffer, vol.byteOffset, NN);          // the original compares float bit patterns as signed ints (ecx = bits of thr)
    const mask = this.mask, out = this.out; let n = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const s = x + 16 * y + 256 * z, a = vi[s];
      // an edge carries a vertex when exactly one end is >= thr
      if (x > 0) { const b = vi[s - 1]; if (b < T ? a >= T : a < T) this._edge(vol, s, s - 1, 0, s - 1, x, y, z, thr); }
      if (z > 0) { const b = vi[s - 256]; if (b < T ? a >= T : a < T) this._edge(vol, s, s - 256, 2, 2 * NN + s - 256, x, y, z, thr); }
      if (y === 0) continue;
      { const b = vi[s - 16]; if (b < T ? a >= T : a < T) this._edge(vol, s, s - 16, 1, NN + s - 16, x, y, z, thr); }
      if (x === 0) continue;
      // 4-bit inside mask of the (x-1..x, y-1..y) square in this z plane (inside = thr < value); the plane below was stored 256 entries earlier
      const m = ((T < vi[s - 1]) << 3) | ((T < a) << 2) | ((T < vi[s - 16]) << 1) | (T < vi[s - 17] ? 1 : 0);
      mask[s + 256] = m;
      if (z === 0) continue;
      const cs = (m << 4) | mask[s];
      if (cs === 0 || cs === 255) continue;
      const tri = TRI[cs], base = s - 273;                                // 273 = 256+16+1: slot of the cell's lowest corner
      for (let i = 0; i < tri.length; i += 3) { out[n++] = tri[i] + base; out[n++] = tri[i + 1] + base; out[n++] = tri[i + 2] + base; }
    }
    this.nTri = n / 3; return this.nTri;
  }
  /** Compact mesh for scene3d: returns {positions, normals, indices, faceNormals} (views, valid until the next call). */
  mesh() {
    const n = this.nTri * 3, remap = this._remap || (this._remap = new Int32Array(3 * NN)), P = this._P || (this._P = new Float32Array(9 * NN)),
      Nn = this._N || (this._N = new Float32Array(9 * NN)), I = this._I || (this._I = new Uint32Array(15 * NN)), FN = this.faceN;
    remap.fill(-1); let m = 0;
    for (let i = 0; i < n; i++) {
      const k = this.out[i]; let r = remap[k];
      if (r < 0) { r = remap[k] = m++; P[3 * r] = this.pos[3 * k]; P[3 * r + 1] = this.pos[3 * k + 1]; P[3 * r + 2] = this.pos[3 * k + 2]; Nn[3 * r] = this.nrm[3 * k]; Nn[3 * r + 1] = this.nrm[3 * k + 1]; Nn[3 * r + 2] = this.nrm[3 * k + 2]; }
      I[i] = r;
    }
    for (let t = 0; t < this.nTri; t++) {            // face normal = (b-a) x (c-a), not normalised (0x58136..)
      const a = 3 * this.out[3 * t], b = 3 * this.out[3 * t + 1], c = 3 * this.out[3 * t + 2], p = this.pos;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      FN[3 * t] = uy * vz - uz * vy; FN[3 * t + 1] = uz * vx - ux * vz; FN[3 * t + 2] = ux * vy - uy * vx;
    }
    return { positions: P.subarray(0, 3 * m), normals: Nn.subarray(0, 3 * m), indices: I.subarray(0, n), faceNormals: FN.subarray(0, 3 * this.nTri) };
  }
}

// ---------------------------------------------------------------- scene3d glue
// scene3d.js (other module) owns scenes/objects. We need: object bounding box, object.setMesh(...), and a camera projection.
let S3D = null;
try { S3D = await import('./scene3d.js'); } catch (e) { S3D = null; }
const _sceneEv = (ctx, name) => ctx.engine && ctx.engine.events.find((e) => e.type === 'scene' && e.name.toLowerCase() === name.toLowerCase());

// ponytail: fallback used only when scene3d.js does not expose the object API.  Object-space bounding box (obj+0xbc..0xd0 of the original)
// = vertices through the inverse of the node matrix (checked against the original: within 3e-5 of its floats); the mesh is just kept in obj.mesh.
let EXP = null; try { EXP = await import('./3d/formats.js'); } catch (e) { EXP = null; }
function expScene(ctx, sceneName) {
  const se = _sceneEv(ctx, sceneName); if (!se) throw new Error('Scene (' + sceneName + ') not found');
  const cache = ctx.__exp || (ctx.__exp = {}), file = words(se.groups[2])[0].toLowerCase();
  return cache[file] || (cache[file] = EXP.parseEXP(ctx.assets.bin(file)));
}
function expObject(ctx, sceneName, objName) {
  const o = expScene(ctx, sceneName).objects.find((q) => q.name.toLowerCase() === objName.toLowerCase());
  if (!o) throw new Error('Object (' + objName + ') not found');
  const m = o.tm, bb = [1e30, 1e30, 1e30, -1e30, -1e30, -1e30], P = o.positions;
  for (let i = 0; i < P.length; i += 3) {
    const d0 = P[i] - m[9], d1 = P[i + 1] - m[10], d2 = P[i + 2] - m[11];
    for (let r = 0; r < 3; r++) { const l = f32(m[3 * r] * d0 + m[3 * r + 1] * d1 + m[3 * r + 2] * d2); bb[r] = Math.min(bb[r], l); bb[3 + r] = Math.max(bb[3 + r], l); }
  }
  return { name: objName, bbox: bb, mesh: null, setMesh(P_, I, N, FN) { this.mesh = { positions: P_, indices: I, normals: N, faceNormals: FN }; } };
}
function sceneObject(ctx, sceneName, objName) {
  if (S3D && S3D.getScene) {
    const sc = S3D.getScene(ctx, sceneName); if (!sc) throw new Error('Scene (' + sceneName + ') not found');
    const o = sc.getObject(objName); if (!o) throw new Error('Object (' + objName + ') not found');
    return o;
  }
  return expObject(ctx, sceneName, objName);
}
const objBBox = (o) => o.bbox || (o.getBBox && o.getBBox());

FX.register('marchingcubes', {
  init(params, ev, ctx) {
    const p = words(params);                                  // "scene object volume flag threshold-expression"
    const obj = sceneObject(ctx, p[0], p[1]), vol = findVolume(ctx, p[2], 'MarchingCubes');
    return { obj, vol, mc: new MarchingCubes(objBBox(obj)), flag: +p[3], thr: ctx.expr(p[4]) };
  },
  run(st, ev) {
    st.mc.run(st.vol, st.thr(ev.local));
    const m = st.mc.mesh();
    st.obj.setMesh(m.positions, m.indices, m.normals, m.faceNormals, { smooth: st.flag !== 0 });   // flag -> object+4 = 2 (Gouraud) / 1 (flat)
  },
});

// ---------------------------------------------------------------- volumesprites: additive texture sprite blitter (0x58f04)
const _d64 = new Float64Array(1), _lo = new Uint32Array(_d64.buffer);
/** the original's "fistp by magic number": adding 1.5*2^36 leaves the value as 16.16 fixed point (rounded to nearest) in the low mantissa dword */
const fix16 = (v) => { _d64[0] = v + 103079215104; return _lo[0] | 0; };

/**
 * Draw one s x s pixel sprite centred on (sx,sy): a 256x256 8-bit texture mapped over the whole square (16.16 fixed point,
 * u/v wrap at 256), colour looked up in pal (0x00RRGGBB, bytes even), and added with per-channel saturation to the 32-bit frame buffer.
 * Exact port of 0x58f04 (clipping, ceil of the edges, sub-pixel start offset, SWAR saturating add).
 */
export function blitSprite(fb, W, H, tex, pal, sx, sy, s, texW = 256, texH = 256) {
  const h = s * 0.5;
  const x0f = sx - h, y0f = sy - h;
  let x0 = (fix16(x0f) + 0xffff) >> 16, y0 = (fix16(y0f) + 0xffff) >> 16;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x0 >= W || y0 >= H) return;
  let x1 = (fix16(h + sx) + 0xffff) >> 16, y1 = (fix16(sy + h) + 0xffff) >> 16;
  if (x1 < 0 || y1 < 0) return;
  if (x1 > W) x1 = W; if (y1 > H) y1 = H;
  const w = x1 - x0, hh = y1 - y0; if (w === 0 || hh === 0) return;
  const du = texW / s, dv = texH / s;
  const U0 = fix16((x0 - x0f) * du), V0 = fix16((y0 - y0f) * dv), dU = fix16(du), dV = fix16(dv);
  const ufr0 = (U0 << 16) >>> 0, uin0 = (U0 >> 16) & 255, dUfr = (dU << 16) >>> 0, dUin = (dU >> 16) & 255;
  let vfr = (V0 << 16) >>> 0, vin = (V0 >> 16) & 255; const dVfr = (dV << 16) >>> 0, dVin = (dV >> 16) & 255;
  for (let y = y0; y < y1; y++) {
    let p = y * W + x0, ufr = ufr0, uin = uin0;
    for (let n = w; n > 0; n--, p++) {
      const sum = (pal[tex[(vin << 8) | uin]] + (fb[p] & 0xfefefefe)) >>> 0;     // both operands have even bytes, so bits 8/16/24 of the sum are the carries
      const c = sum & 0x1010100;
      fb[p] = ((c - (c >>> 8)) | sum) >>> 0;                                      // carry -> 0xff in the channel below (saturation)
      const t = ufr + dUfr; uin = (uin + dUin + (t > 0xffffffff ? 1 : 0)) & 255; ufr = t >>> 0;
    }
    const t = vfr + dVfr; vin = (vin + dVin + (t > 0xffffffff ? 1 : 0)) & 255; vfr = t >>> 0;
  }
}

// ---------------------------------------------------------------- volumesprites effect (0x18eb3 init, 0x190cb run)
/** colour ramp of a material (0x21b9b): pal[i] = rgb(i/160 * c * 256), clamped, low bit of every byte cleared (so the saturating add of the blitter works) */
function rampPalette(c) {
  const pal = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = f32(i / 160); let v = 0;
    for (let k = 0; k < 3; k++) { let q = Math.round(t * c[k] * 256); if (Math.abs((t * c[k] * 256) % 1) === 0.5 && (q & 1)) q--; v = (v << 8) | Math.min(q, 255); }
    pal[i] = (v & 0xfefefefe) >>> 0;
  }
  return pal;
}
const _pp = { x: 0, y: 0, z: 0, ok: true };
FX.register('volumesprites', {
  // params: scene object volume.  One sprite for every voxel of the volume with value*35 >= 1, drawn through the camera of the scene.
  init(params, ev, ctx) {
    const p = words(params), obj = sceneObject(ctx, p[0], p[1]), vol = findVolume(ctx, p[2], 'VolumeSprites');
    const bb = objBBox(obj).map(f32), step = [0, 1, 2].map((k) => f32((bb[3 + k] - bb[k]) / 15));
    // texture + palette of the first material of the scene (0x10d91c = material array): 256x256 8 bit indices, ramp of the material colour
    let colour = [0.2, 0.35, 0.2], texName = 'pink.tga';
    try { const m = expScene(ctx, p[0]).materials[0]; colour = m.ambient; texName = m.texture.replace(/\.png$/, '.tga'); } catch (e) { /* defaults = box2.exp */ }
    const tex = ctx.assets.idx(texName).data;
    return { obj, vol, min: bb.slice(0, 3), step, tex, pal: rampPalette(colour), scene: p[0], pos: new Float32Array(3) };
  },
  run(st, ev, ctx) {
    const out = ev.outputs[0], W = out.w, H = out.h, v = st.vol, P = st.pos;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let a = f32(v[x + 16 * y + 256 * z] * 35);
      if (a < 1) continue;
      if (a > 120) a = 120;
      P[0] = x * st.step[0] + st.min[0]; P[1] = y * st.step[1] + st.min[1]; P[2] = z * st.step[2] + st.min[2];
      if (!projectVolumePoint(ctx, st, P, _pp) || !_pp.ok) continue;      // behind the near plane (flag 0x10)
      const size = f32(a * (150 / _pp.z));                                 // 150/z * (value*35)
      if (size < 3.5) continue;
      blitSprite(out.data, W, H, st.tex, st.pal, _pp.x, _pp.y, size);
    }
  },
});
// camera: scene3d's projectPoint (object-space point -> screen + view depth). ponytail: crude fallback when scene3d.js is absent
// (fixed camera looking down +z at 400 units), only good enough to see the sprites.
function projectVolumePoint(ctx, st, P, out) {
  if (S3D && S3D.projectPoint) { out.ok = true; const r = S3D.projectPoint(ctx, S3D.getScene ? S3D.getScene(ctx, st.scene) : null, P, out, st.obj); return r === undefined ? out.ok : r; }
  out.z = 400 + P[2]; out.x = 160 + P[0] * 300 / out.z; out.y = 100 - P[1] * 300 / out.z; out.ok = out.z > 1; return out.ok;
}
