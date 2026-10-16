// flares.js - `setupflares` and `flareparticles` (original: flares.c / the code at 0x1a808..0x1b2c7 and the sprite
// blitter at 0x5976c of 73MS.EXE).  Additive, table-shaded, texture-mapped sprites into an 8-bit buffer.
//
// What the original does (see docs/notes/flares-*.html):
//  * flareparticles keeps N particles per light.  They are born on the light's (animated) world position with a random
//    velocity, live fadeIn+fadeOut centiseconds and are projected with the scene camera every frame.
//  * each particle is a screen aligned square (size grows 0..200..300 world units, divided by depth) drawn by a self
//    modifying 16.16 fixed-point texture mapper: dst = min(255, dst + table[intensity][texel]).
//  * the light positions and the camera come from smoke.exp (UEXP file, TCB spline tracks) - they are evaluated here
//    (parseUexp/Track) because the original reads them from the scene record that the `scene` effect has just updated.
import { FX, compileExpr } from '../core.js';

// ------------------------------------------------------------------ random generator (Watcom rand(), 0x5153c)
// seed' = seed*0x41C64E6D + 0x3039 ; result = (seed' >> 16) & 0x7fff.  There is no srand() in the demo; the value below
// is the generator state when the first flareparticles event initialises (measured in the emulator, the earlier
// effects of the demo consume a deterministic number of values).
const SEED0 = 2077067425;
let seed = SEED0;
function rand15() { seed = (Math.imul(seed, 0x41c64e6d) + 0x3039) >>> 0; return (seed >>> 16) & 0x7fff; }

const f32 = Math.fround;

// ------------------------------------------------------------------ UEXP (smoke.exp) reader: only what flares need
// layout (reverse engineered from loaduexp.c, verified on smoke.exp):
//  u32 'UEXP', nMat, nCam, nHelper, nLight, n954, nObj, f32 length
//  material  = 121 bytes;  object = name[16] nv u32 nf ... (0x70 byte header) +12*nv +16*nf +vec3 +2 tracks
//  camera    = 3 tracks, then 24 bytes {u32,u32,f32 fov,u32,u32,u32}      (track 1 = unused here, 2 = eye, 3 = target)
//  light     = name[16] + 5 f32 + u32 + 1 track
//  track     = u32 n, n * { f32 frame, f32 x,y,z, f32 tension,continuity,bias }
const KEY = 28;
function readTrack(dv, o) {
  const n = dv.getUint32(o, true); o += 4; const k = new Float64Array(n * 7);
  for (let i = 0; i < n * 7; i++) k[i] = dv.getFloat32(o + i * 4, true);
  return [{ n, k }, o + n * KEY];
}
export function parseUexp(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x50584555) throw new Error('not a UEXP file');
  const nMat = dv.getUint32(4, true), nCam = dv.getUint32(8, true), nHelp = dv.getUint32(12, true),
    nLight = dv.getUint32(16, true), n954 = dv.getUint32(20, true), nObj = dv.getUint32(24, true);
  const length = dv.getFloat32(28, true);
  if (nHelp || n954 || nCam !== 1) throw new Error('UEXP: unsupported layout');
  let o = 32 + nMat * 121, tr;
  for (let i = 0; i < nObj; i++) {
    const nv = dv.getUint32(o + 16, true), nf = dv.getUint32(o + 24, true);
    o += 0x70 + 12 * nv + 16 * nf + 12;
    [, o] = readTrack(dv, o); [, o] = readTrack(dv, o);
  }
  const cam = {};
  [, o] = readTrack(dv, o); [cam.eye, o] = readTrack(dv, o); [cam.target, o] = readTrack(dv, o);
  cam.fov = dv.getFloat32(o + 8, true); o += 24;
  const lights = [];
  for (let i = 0; i < nLight; i++) {
    let name = ''; for (let j = 0; j < 16 && u8[o + j]; j++) name += String.fromCharCode(u8[o + j]);
    [tr, o] = readTrack(dv, o + 0x28); lights.push({ name, track: tr });
  }
  if (o !== u8.byteLength) throw new Error('UEXP: trailing/missing bytes ' + o + ' vs ' + u8.byteLength);
  return { length, cam, lights };
}

// 3D Studio style TCB spline (Kochanek-Bartels with the 3DS time compensation); end tangents = chord.  Verified against
// the camera/light positions of the original within 0.02 units.
export function evalTrack(tr, f, out) {
  const { n, k } = tr;
  if (n === 1 || f <= k[0]) { out[0] = k[1]; out[1] = k[2]; out[2] = k[3]; return out; }
  let i = 0; while (i < n - 2 && f > k[(i + 1) * 7]) i++;     // past the last key: linear extrapolation
  const N = (j) => k[(j + 1) * 7] - k[j * 7];
  const s = (f - k[i * 7]) / N(i), s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const last = n - 1, END = TAIL - k[last * 7]; // the missing neighbour of the last key sits at time TAIL, same position
  for (let c = 0; c < 3; c++) {
    const P = (j) => k[j * 7 + 1 + c];
    const tan = (j) => { // [source, dest] tangents of key j (interior keys)
      const t = k[j * 7 + 4], cc = k[j * 7 + 5], b = k[j * 7 + 6], d0 = P(j) - P(j - 1), d1 = P(j + 1) - P(j);
      const ds = 0.5 * ((1 - t) * (1 - cc) * (1 + b) * d0 + (1 - t) * (1 + cc) * (1 - b) * d1) * 2 * N(j) / (N(j - 1) + N(j));
      const dd = 0.5 * ((1 - t) * (1 + cc) * (1 + b) * d0 + (1 - t) * (1 - cc) * (1 - b) * d1) * 2 * N(j - 1) / (N(j - 1) + N(j));
      return [ds, dd];
    };
    const p0 = P(i), p1 = P(i + 1);
    const ds0 = i > 0 ? tan(i)[0] : p1 - p0;
    const dd1 = i + 1 < last ? tan(i + 1)[1] : (p1 - p0) * N(i) / (N(i) + END);
    out[c] = s > 1 ? p1 + dd1 * (s - 1)               // after the last key: straight line with the end tangent
      : h00 * p0 + h10 * ds0 + h01 * p1 + h11 * dd1;
  }
  return out;
}
const TAIL = 65536;

// ------------------------------------------------------------------ scene access (own parse of the .exp)
const sceneCache = new WeakMap(); // scene event -> {exp, speed, offset, start}
function sceneOf(ctx, ev, name) {
  const se = ctx.engine && ctx.engine.events.find((e) => e.name.toLowerCase() === name.toLowerCase() && e.layer === ev.layer && e.type === 'scene');
  if (!se) throw new Error('FlareParticles: Scene (' + name + ') not found');
  let s = sceneCache.get(se);
  if (!s) {
    const [file, speed, off] = (se.groups[2] || '').trim().split(/\s+/);
    // ponytail: the shared parser (scene3d.js) would be used here when it exposes lights/cameras per frame
    s = { exp: parseUexp(ctx.assets.bin(file.toLowerCase())), speed: parseFloat(speed), offset: parseFloat(off || '0'), start: se.t0, ev: se };
    sceneCache.set(se, s);
  }
  return s;
}
/** animation time of the scene at the current frame, as in the render function 0x4fa0 (loops when past the end). */
function sceneTime(ctx, s) {
  let f = (ctx.frame - s.start) * s.speed * 0.01;
  if (f >= s.exp.length - 0.5) { s.start = ctx.frame; f = 0; }
  return f + s.offset;
}

// ------------------------------------------------------------------ textures / shading table (matmgr + 0x40..0xf0)
const texCache = new WeakMap();
function flareTexture(ctx, lightName) {
  // texture "f2" = flare2.unr, "f1" = flare1.unr; the light name up to the first '.' selects it, default = last registered (f1)
  const key = lightName.split('.')[0].toLowerCase() === 'f2' ? 'flare2.unr' : 'flare1.unr';
  let t = texCache.get(ctx.assets);
  if (!t) texCache.set(ctx.assets, t = {});
  if (!t[key]) {
    const im = ctx.assets.image(key), tex = new Uint8Array(65536); // 8 bit image kept with a stride of 256
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) tex[y * 256 + x] = im.rgb[y * im.w + x] & 0xff; // palette = grey ramp
    t[key] = { data: tex, w: im.w, h: im.h };
  }
  return t[key];
}
let TABLE = null; // table[a*256 + j] = (j*a) >> 8 : texel scaled by intensity a (original at [0xdc28c], built at startup)
function shadeTable() {
  if (TABLE) return TABLE;
  TABLE = new Uint8Array(65536);
  for (let a = 0; a < 256; a++) for (let j = 0; j < 256; j++) TABLE[a * 256 + j] = (j * a) >> 8;
  return TABLE;
}

// ------------------------------------------------------------------ the sprite blitter (0x5976c)
const M = 65536;
/** float -> 16.16 fixed the way the original does it: fadd 1.5*2^36, fstp qword, read the low dword (round to nearest even). */
function fix(x) {
  const v = x * M; let r = Math.floor(v + 0.5);
  if (r - v === 0.5 && (r & 1)) r--;
  return r | 0;
}
/**
 * Draws a screen aligned wpx x hpx sprite centred on (X, Y) into the 8 bit buffer, additive with saturation.
 * (X,Y,wpx,hpx) = the 4 FPU stack arguments, texW/texH = floats read from the texture record, tbl = shading row.
 */
export function drawSprite(dst, sw, sh, tex, texW, texH, tblBase, wpx, hpx, X, Y) {
  const x0 = X - wpx * 0.5, x1 = X + wpx * 0.5, y0 = Y - hpx * 0.5, y1 = Y + hpx * 0.5;
  const du = texW / wpx, dv = texH / hpx;
  const x0f = fix(x0), y0f = fix(y0), x1f = fix(x1), y1f = fix(y1);
  let xs = (x0f + 0xffff) >> 16; if (xs < 0) xs = 0;            // ceil, clamp left/top to the screen
  let ys = (y0f + 0xffff) >> 16; if (ys < 0) ys = 0;
  if (xs >= sw || ys >= sh) return;
  let xe = (x1f + 0xffff) >> 16; if (xe < 0) return;
  let ye = (y1f + 0xffff) >> 16; if (ye < 0) return;
  if (xe > sw) xe = sw; if (ye > sh) ye = sh;
  const cnt = xe - xs, rows = ye - ys;
  if (cnt <= 0 || rows <= 0) return;
  const skip = sw - cnt;
  const u0 = fix((xs - x0) * du), v0 = fix((ys - y0) * dv), duF = fix(du), dvF = fix(dv);
  const uInt0 = (u0 >> 16) & 255, uFrac0 = u0 << 16 >>> 0, duInt = (duF >> 16) & 255, duFrac = duF << 16 >>> 0;
  const dvInt = (dvF >> 16) & 255, dvFrac = dvF << 16 >>> 0;
  let ch = (v0 >> 16) & 255, vFrac = v0 << 16 >>> 0;
  let p = ys * sw + xs;
  for (let y = 0; y < rows; y++) {
    let cl = uInt0, esi = uFrac0;
    const tr = ch << 8;
    for (let x = 0; x < cnt; x++) {
      const t = tex[tr | cl];                       // mov al,[ecx+tex]
      esi += duFrac; const c = esi > 0xffffffff ? 1 : 0; esi >>>= 0;   // add esi,imm32
      cl = (cl + duInt + c) & 255;                  // adc cl,imm8
      const s = dst[p] + TABLE[tblBase + t];        // add bl,[eax+table]
      dst[p++] = s > 255 ? 255 : s;                 // sbb dl,dl ; or bl,dl  (saturate)
    }
    vFrac += dvFrac; const c = vFrac > 0xffffffff ? 1 : 0; vFrac >>>= 0;
    ch = (ch + dvInt + c) & 255;
    p += skip;
  }
}

// ------------------------------------------------------------------ setupflares
// params "scena <expr>": the expression (of Frame) is stored in the scene record at +0x28, which the 3D renderer reads as
// the size factor of the light flares of the scene itself (0x10d928).  We expose it as ctx.flareScale[sceneName].
FX.register('setupflares', {
  init(params, ev, ctx) {
    seed = SEED0; // (deterministic restart of the demo's rand() stream; see SEED0)
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(params);
    if (!m) throw new Error('SetupFlares: Params error');
    return { scene: m[1], expr: compileExpr(m[2]), start: null, value: 0 };
  },
  run(st, ev, ctx) {
    if (st.start === null) st.start = ctx.frame;
    st.value = st.expr(ctx.frame - st.start);
    (ctx.flareScale || (ctx.flareScale = {}))[st.scene] = st.value;
  },
});

// ------------------------------------------------------------------ flareparticles
// params: scene camIndex light count  lifeIn lifeOut speed rndLife  s0 s1 s2  i0 i1 i2   (format "%s %d %s %d %f x10")
//   p20=30  fade-in time (cs), p24=370 fade-out time, p28=0.6 velocity range, p2c=0 life randomness,
//   size: p30=0 -> p34=200 (fade in) -> p38=300 (fade out) ; intensity: p3c=0 -> p40=0.2 -> p44=0.01
FX.register('flareparticles', {
  init(params, ev, ctx) {
    const a = params.trim().split(/\s+/);
    if (a.length !== 14) throw new Error('FlareParticles: Params error');
    const P = a.slice(4).map(Number);
    const s = {
      sceneName: a[0], cam: +a[1], lightName: a[2], n: +a[3],
      p20: f32(P[0]), p24: f32(P[1]), p28: f32(P[2]), p2c: f32(P[3]), p30: f32(P[4]), p34: f32(P[5]), p38: f32(P[6]), p3c: f32(P[7]),
      p40: f32(P[8]), p44: f32(P[9]),
      sc: sceneOf(ctx, ev, a[0]), started: false, t0: 0, acc: 0, part: null, pos: new Float64Array(3), mat: new Float64Array(12),
      tmp: new Float64Array(3), tmp2: new Float64Array(3),
    };
    const L = s.sc.exp.lights.find((l) => l.name.toLowerCase() === a[2].toLowerCase());
    if (!L) throw new Error('FlareParticles: Light (' + a[2] + ') not found');
    s.light = L; s.tex = flareTexture(ctx, L.name); shadeTable();
    s.part = new Float32Array(s.n * 9); // x y z vx vy vz age life1 life2  (36 bytes per particle in the original)
    return s;
  },
  run(s, ev, ctx) {
    const out = ev.outputs[0] || ev.inputs[0];
    const sw = out.w, sh = out.h, dst = out.data, part = s.part, n = s.n;
    const fov = s.sc.exp.cam.fov;
    const fx = f32(sw * 0.5 / Math.tan(fov * 0.5)), fy = f32(fx * (sh / sw) * (4 / 3)); // cam+0x20/+0x24 (386.274, 321.895)
    const cx = f32(sw * 0.5), cy = f32(sh * 0.5), NEAR = 0.5;
    // current light position and camera (the scene effect has just advanced the animation to this frame)
    const f = sceneTime(ctx, s.sc);
    const lp = evalTrack(s.light.track, f, s.pos); const lx = f32(lp[0]), ly = f32(lp[1]), lz = f32(lp[2]);
    const eye = evalTrack(s.sc.exp.cam.eye, f, s.tmp), tg = evalTrack(s.sc.exp.cam.target, f, s.tmp2);
    // look-at matrix, world up = +Z (rows r0..r2 = view-space images of the world axes, as stored at cam+0x98..)
    let zx = tg[0] - eye[0], zy = tg[1] - eye[1], zz = tg[2] - eye[2]; let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = zy, xy = -zx; l = Math.hypot(xx, xy) || 1; xx /= l; xy /= l;           // x = z cross up
    const yx = zy * 0 - zz * xy, yy = zz * xx - zx * 0, yz = zx * xy - zy * xx;       // y = z cross x
    const m = s.mat;
    m[0] = f32(xx); m[1] = f32(yx); m[2] = f32(zx);   // r0 = images of world x
    m[3] = f32(xy); m[4] = f32(yy); m[5] = f32(zy);   // r1
    m[6] = 0; m[7] = f32(yz); m[8] = f32(zz);         // r2
    m[9] = f32(-(xx * eye[0] + xy * eye[1])); m[10] = f32(-(yx * eye[0] + yy * eye[1] + yz * eye[2])); m[11] = f32(-(zx * eye[0] + zy * eye[1] + zz * eye[2]));
    s.view = m;

    if (!s.started) { // first run: spawn all particles at the light with random velocities and random ages
      s.started = true; s.t0 = ev.local; s.acc = 0;
      for (let i = 0, b = 0; i < n; i++, b += 9) {
        part[b] = lx; part[b + 1] = ly; part[b + 2] = lz;
        part[b + 3] = (rand15() / 32767 * 2 - 1) * s.p28;
        part[b + 4] = (rand15() / 32767 * 2 - 1) * s.p28;
        part[b + 5] = (rand15() / 32767 * 2 - 1) * s.p28;
        part[b + 7] = s.p20; part[b + 8] = s.p24;
        part[b + 6] = rand15() / 32767 * (s.p20 + s.p24);
      }
    }
    let dt = f32(ev.local - s.t0 - s.acc);
    if (dt > 0.001) {
      const tbl = TABLE, tex = s.tex.data;
      for (let i = 0, b = 0; i < n; i++, b += 9) {
        part[b + 6] += dt;
        if (part[b + 7] + part[b + 8] < part[b + 6]) {       // dead -> respawn at the light
          part[b] = lx; part[b + 1] = ly; part[b + 2] = lz;
          part[b + 3] = (rand15() / 32767 * 2 - 1) * s.p28;
          part[b + 4] = (rand15() / 32767 * 2 - 1) * s.p28;
          part[b + 5] = (rand15() / 32767 * 2 - 1) * s.p28;
          part[b + 7] = (rand15() / 32767 * s.p2c + 1) * s.p20;
          part[b + 8] = (rand15() / 32767 * s.p2c + 1) * s.p24;
          part[b + 6] = 0;
        } else {
          part[b] += part[b + 3] * dt; part[b + 1] += part[b + 4] * dt; part[b + 2] += part[b + 5] * dt;
        }
        const age = part[b + 6], l1 = part[b + 7], l2 = part[b + 8];
        let size, inten;
        if (age > l1) { const t = f32((age - l1) / l2); size = f32((s.p38 - s.p34) * t + s.p34); inten = f32((s.p44 - s.p40) * t + s.p40); }
        else { const t = f32(age / l1); size = f32((s.p34 - s.p30) * t + s.p30); inten = f32((s.p40 - s.p3c) * t + s.p3c); }
        let idx = Math.trunc(inten * 255); if (idx > 255) idx = 255;
        // world -> view
        const px = part[b], py = part[b + 1], pz = part[b + 2];
        const vx = f32(m[3] * py + m[0] * px + m[6] * pz + m[9]);
        const vy = f32(m[4] * py + m[1] * px + m[7] * pz + m[10]);
        const vz = f32(m[5] * py + m[2] * px + m[8] * pz + m[11]);
        if (!(vz > NEAR)) continue;                          // 0x588d8: outcode bit 0x10 = behind the near plane
        const A = f32(vx * fx), B = f32(vy * fy), rz = 1 / vz;
        const sx = f32(A * rz + cx), sy = f32(B * rz + cy);
        const wpx = f32(fx * size / vz), hpx = f32(fy * size / vz);
        if (wpx >= 320) continue;                            // cmp [-0x3c], 320.0 ; jge
        if (ctx.flareTrace) ctx.flareTrace(part, b, vz, wpx, hpx, sx, sy, idx); // test hook (compared with the emulator)
        drawSprite(dst, sw, sh, tex, s.tex.w, s.tex.h, idx << 8, wpx, hpx, sx, sy);
      }
    }
    s.acc += dt;
  },
  free() {},
});
