// scene3d.js - the 3D system of "73 million seconds": scene file loaders (UNLW .lwe, UEXP .exp, LWV objects), keyframe
// animation, a software renderer and the `scene` effect (see API3D.md for the API used by the volume / flare modules).
import { FX } from '../core.js';
import { Hooks } from '../engine.js';
import { parseLWE, parseLWV, parseEXP } from './3d/formats.js';
import { evalKeys } from './3d/anim.js';
import { hpbToMatrix } from './3d/math3d.js';
import { triTex32, triTex8, triDelta16 } from './3d/raster.js';

const NEAR = 0.5; // near plane in camera space (0x10d8ac, set at 0x4cce)
const IDENT = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };

/** A named object of a scene. `world` = column-major 4x4 (object -> world) valid after Scene3D.evaluate(). */
export class SceneObject {
  constructor(name, kind) {
    this.name = name; this.kind = kind; this.world = IDENT(); this.visible = true;
    this.mesh = null;   // { positions Float32Array(3n), normals Float32Array(3n), uv Float32Array(2n) | null, indices Uint32Array(3t), tsurf Uint16Array(t), surfaces[] }
    this.bbox = null; this.meshVersion = 0; this.keys = null; this.base = null; this.smooth = true;
  }
  /** Replace the geometry (used by marchingcubes). normals optional (then flat normals are derived). Positions are in object space. */
  setMesh(positions, indices, normals, faceNormals, opts) {
    const n = positions.length / 3;
    const m = this.mesh || {}; const surfaces = m.surfaces || [{ name: 'mc', texture: '', color: [255, 255, 255], opacity: 255, mode: 4 }];
    // the polygons keep the material of the first polygon of the original object (not material 0)
    const first = m.tsurf && m.tsurf.length ? m.tsurf[0] : 0;
    const tsurf = new Uint16Array(indices.length / 3); tsurf.fill(first);
    this.mesh = { positions, indices, normals: normals || computeNormals(positions, indices), uv: null, tsurf, surfaces };
    this.smooth = !(opts && opts.smooth === false);
    this.bbox = bboxOf(positions); this.meshVersion++;
  }
  getBBox() { return this.bbox; }
}

export class Scene3D {
  constructor(file, kind) {
    this.file = file; this.kind = kind; this.objects = []; this.nulls = []; this.lights = []; this.duration = 1000; this.fps = 30;
    this.camera = { pos: new Float64Array(3), R: new Float64Array(9), zoom: 359.37, roll: 0 }; // R: camera axes (columns) in world space: cam = R^T (p - pos)
    this.flag = ''; this.lwotr = 255; this.lwoshading = 4; this.time = 0; this.target = null;
    this._d = new Float64Array(6);
  }
  // the original renames "x.lwo" to "x.lwv" in the object record, scripts use the .lwv spelling
  getObject(name) { const n = name.toLowerCase().replace(/\.lw[ov]$/, ''); return this.objects.find((o) => o.name.toLowerCase().replace(/\.lw[ov]$/, '') === n) || null; }
  getNull(name) { name = name.toLowerCase(); return this.nulls.find((o) => o.name.toLowerCase() === name) || null; }
  getLight(name) { name = name.toLowerCase(); return this.lights.find((o) => o.name.toLowerCase() === name) || null; }

  /** Evaluate every animated entity at scene frame t (the `scene` effect passes (seconds*speed+offset)). */
  evaluate(t) {
    this.time = t; const d = this._d;
    const key = (keys, n) => { evalKeys(keys, t, d.subarray(0, n), keys[keys.length - 1].frame); return d; };
    if (this.kind === 'lwe') {
      for (const o of this.objects.concat(this.nulls)) {
        key(o.keys, 6); const W = o.world; const R = o._R || (o._R = new Float64Array(9)); hpbToMatrix(d[3], d[4], d[5], R);
        W[0] = R[0]; W[1] = R[3]; W[2] = R[6]; W[3] = 0; W[4] = R[1]; W[5] = R[4]; W[6] = R[7]; W[7] = 0; W[8] = R[2]; W[9] = R[5]; W[10] = R[8]; W[11] = 0; W[12] = d[0]; W[13] = d[1]; W[14] = d[2]; W[15] = 1;
        o.pos = [d[0], d[1], d[2]];
      }
      for (const l of this.lights) { key(l.keys, 6); l.pos[0] = d[0]; l.pos[1] = d[1]; l.pos[2] = d[2]; }
      const c = this.camera, ck = this.camsrc.keys; key(ck, 6);
      c.pos[0] = d[0]; c.pos[1] = d[1]; c.pos[2] = d[2]; hpbToMatrix(d[3], d[4], d[5], c.R);
      c.R[1] = -c.R[1]; c.R[4] = -c.R[4]; c.R[7] = -c.R[7]; // screen y points down
    } else { // exp: positions are keyed in world space, geometry is stored in world space at frame 0
      for (const o of this.objects) {
        if (o.keys && o.keys.length) { key(o.keys, 3); const W = o.world; W[12] = d[0] - o.base[0]; W[13] = d[1] - o.base[1]; W[14] = d[2] - o.base[2]; o.pos = [d[0], d[1], d[2]]; }
      }
      for (const l of this.lights) { key(l.keys, 3); l.pos[0] = d[0]; l.pos[1] = d[1]; l.pos[2] = d[2]; }
      const cs = this.camsrc, c = this.camera; const e = new Float64Array(3), g = new Float64Array(3);
      evalKeys(cs.pos, t, e, cs.pos[cs.pos.length - 1].frame); evalKeys(cs.target, t, g, cs.target[cs.target.length - 1].frame);
      c.pos[0] = e[0]; c.pos[1] = e[1]; c.pos[2] = e[2];
      let fx = g[0] - e[0], fy = g[1] - e[1], fz = g[2] - e[2]; const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      // 3ds max is Z up: right = forward x up, down = forward x right
      let rx = fy * 1 - fz * 0, ry = fz * 0 - fx * 1, rz = 0; const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      const dx = fy * rz - fz * ry, dy = fz * rx - fx * rz, dz = fx * ry - fy * rx;
      const R = c.R; R[0] = rx; R[3] = ry; R[6] = rz; R[1] = dx; R[4] = dy; R[7] = dz; R[2] = fx; R[5] = fy; R[8] = fz;
      const fov = cs.fov.length ? cs.fov[0].value : 0.8; c.fov = fov; c.zoom = this.width * 0.5 / Math.tan(fov * 0.5);
    }
  }
  /** World point -> camera space [x,y,z] into out (Float64Array(3)) */
  toCamera(p, out) {
    const c = this.camera, R = c.R, x = p[0] - c.pos[0], y = p[1] - c.pos[1], z = p[2] - c.pos[2];
    out[0] = R[0] * x + R[3] * y + R[6] * z; out[1] = R[1] * x + R[4] * y + R[7] * z; out[2] = R[2] * x + R[5] * y + R[8] * z; return out;
  }
}

/** Project a world space point with the camera of `scene` as the renderer does: out = [screenX, screenY, cameraZ]. Returns false if behind the camera. */
const _pc = new Float64Array(3);
export function projectPoint(ctx, scene, p3, out) {
  scene.toCamera(p3, _pc); const w = scene.width || 320, h = scene.height || 200, z = _pc[2];
  out[2] = z; if (z <= NEAR) { out[0] = out[1] = 0; return false; }
  out[0] = w * 0.5 + _pc[0] * scene.camera.zoom / z; out[1] = h * 0.5 + _pc[1] * scene.camera.zoom / z; return true;
}

/** scene by script name: the instance name of a `scene` event ("jabole") or the file name given to loadscene. */
export function getScene(ctx, name) {
  if (!name) return null; const n = name.toLowerCase();
  const evs = ctx.engine && ctx.engine.events;
  if (evs) for (const e of evs) if (e.type === 'scene' && e.name.toLowerCase() === n && e.state && e.state.scene) return e.state.scene;
  if (ctx.scenes && ctx.scenes[n]) return ctx.scenes[n];
  return null;
}

// ------------------------------------------------------------------------------------------------ mesh helpers
function bboxOf(P) { const b = [1e30, 1e30, 1e30, -1e30, -1e30, -1e30]; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < b[k]) b[k] = P[i + k]; if (P[i + k] > b[3 + k]) b[3 + k] = P[i + k]; } return b; }
function computeNormals(P, I, flip) {  // smooth: sum of unit face normals per vertex, normalised (as 0x5dbb0 does)
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (flip) { nx = -nx; ny = -ny; nz = -nz; } const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
  return N;
}
function makeObject(name, kind, lwv, keys, shading, lwotr) {
  const o = new SceneObject(name, kind); o.keys = keys;
  if (lwv) {
    o.mesh = { positions: lwv.positions, normals: computeNormals(lwv.positions, lwv.indices, true), uv: lwv.uv, indices: lwv.indices, tsurf: lwv.tsurf,
      surfaces: lwv.surfaces.map((s) => ({ name: s.name, texture: s.texture, color: s.color, opacity: lwotr, mode: shading })) };
    o.bbox = bboxOf(lwv.positions);
  }
  return o;
}

/** Hooks.loadScene: `loadscene file buffer flag`. ctx.lwotr / ctx.lwoshading at load time are baked into the surfaces (as the original does). */
// The original's lwotr / lwoshading globals start at 7 / 3 (data at 0xc3258); the engine's ctx defaults (255 / 4) only apply once the script has issued the commands.
function surfaceDefaults(ctx) {
  const e = ctx.engine; if (!e || !e.cmds) return [ctx.lwotr, ctx.lwoshading];
  let tr = 7, sh = 3;
  for (let i = 0; i < e.next && i < e.cmds.length; i++) { const c = e.cmds[i]; if (c.cmd === 'lwotr') tr = +c.rest; else if (c.cmd === 'lwoshading') sh = +c.rest; }
  return [tr, sh];
}
export function loadScene(file, bufName, flag, ctx) {
  const f = file.toLowerCase(), bin = ctx.assets.bin(f), u8 = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  let S;
  if (f.endsWith('.exp')) {
    const d = parseEXP(u8); S = new Scene3D(f, 'exp'); S.duration = d.duration;
    S.materials = d.materials;
    for (const o of d.objects) {
      const mats = d.materials;
      const so = new SceneObject(o.name, 'object');
      const n = o.positions.length / 3;
      const surfaces = mats.map((m) => ({ name: m.name, texture: m.texture, color: m.diffuse.map((x) => x * 255), opacity: m.opacity, mode: m.mode }));
      so.mesh = { positions: o.positions, normals: computeNormals(o.positions, o.indices), uv: null, uvs: o.uvs, triUV: o.triUV, indices: o.indices, tsurf: o.tmat, surfaces };
      so.bbox = bboxOf(o.positions); so.keys = o.pos.length ? o.pos.map((k) => ({ frame: k.frame, v: k.v, tension: k.tension, continuity: k.continuity, bias: 0, linear: k.linear })) : null;
      so.base = o.pos.length ? o.pos[0].v.slice() : [0, 0, 0]; S.objects.push(so);
    }
    for (const l of d.lights) S.lights.push({ name: l.name, color: l.color, pos: [0, 0, 0], keys: l.pos.map((k) => ({ frame: k.frame, v: k.v, tension: k.tension, continuity: k.continuity, bias: 0, linear: k.linear })) });
    const c = d.cameras[0]; const kk = (a) => a.map((k) => ({ frame: k.frame, v: k.v, tension: k.tension, continuity: k.continuity, bias: 0, linear: k.linear }));
    S.camsrc = { pos: kk(c.pos), target: kk(c.target), fov: c.fov, roll: c.roll };
  } else {
    const sd = surfaceDefaults(ctx); const d = parseLWE(u8); S = new Scene3D(f, 'lwe'); S.duration = d.duration;
    for (const o of d.objects) {
      const lwvName = o.name.toLowerCase().replace(/\.lwo$/, '.lwv'); let lwv = null;
      try { lwv = parseLWV(ctx.assets.bin(lwvName)); } catch (e) { console.warn('scene3d: object file ' + lwvName + ' missing'); }
      S.objects.push(makeObject(o.name, 'object', lwv, o.keys, sd[1], sd[0]));
    }
    for (const n of d.nulls) S.nulls.push(makeObject(n.name, 'null', null, n.keys, 0, 0));
    for (const l of d.lights) S.lights.push({ name: 'light', color: l.color, pos: [0, 0, 0], keys: l.keys });
    S.camsrc = d.cameras[0]; S.camera.zoom = 359.37;
  }
  S.flag = flag || ''; S.lwotr = surfaceDefaults(ctx)[0]; S.lwoshading = surfaceDefaults(ctx)[1]; S.width = 320; S.height = 200;
  S.evaluate(0);
  return S;
}
Hooks.loadScene = loadScene;

// ------------------------------------------------------------------------------------------------ renderer
const texCache = new Map();
function getTex(ctx, name, bpp) {
  const key = name + '/' + bpp; let t = texCache.get(key); if (t) return t;
  let rgb = null;
  try { const im = ctx.assets.image(name || 'echo.png'); rgb = im.rgb; if (im.w !== 256 || im.h !== 256) rgb = null; } catch (e) { rgb = null; }
  if (!rgb) { rgb = new Uint32Array(65536); for (let i = 0; i < 65536; i++) { const g = i & 255; rgb[i] = (g << 16) | (g << 8) | g; } }
  if (bpp === 8) { const l = new Uint8Array(65536); for (let i = 0; i < 65536; i++) { const c = rgb[i]; l[i] = ((c >> 16 & 255) * 77 + (c >> 8 & 255) * 150 + (c & 255) * 29) >> 8; } t = l; } else t = rgb;
  texCache.set(key, t); return t;
}

function Renderer() {
  this.cap = 0;
}
Renderer.prototype.ensure = function (nv, nt) {
  if (this.cap >= nv && this.capT >= nt) return;
  this.cap = nv; this.capT = nt;
  this.cx = new Float64Array(nv); this.cy = new Float64Array(nv); this.cz = new Float64Array(nv);
  this.sx = new Float64Array(nv); this.sy = new Float64Array(nv); this.u = new Float64Array(nv); this.v = new Float64Array(nv);
  this.key = new Float64Array(nt); this.ord = new Uint32Array(nt); this.cnt = new Uint32Array(1025);
};

const _R = new Float64Array(9), _cl = new Float64Array(8 * 6), _tmp = new Float64Array(8 * 6);

/** Draw one scene into the target buffer. t = scene frame. */
export function renderScene(ctx, scene, buf, flagBeams) {
  const W = buf.w, H = buf.h, bpp = buf.bpp, cam = scene.camera, R = cam.R, zoom = cam.zoom, hw = W * 0.5, hh = H * 0.5;
  const rn = scene._rn || (scene._rn = new Renderer());
  const light = scene.lights[0]; const lc = new Float64Array(3);
  if (light) scene.toCamera(light.pos, lc);
  const useBeams = flagBeams && bpp === 16;
  for (const o of scene.objects) {
    if (!o.visible || !o.mesh) continue; const m = o.mesh, P = m.positions, N = m.normals, nv = P.length / 3, nt = m.indices.length / 3;
    rn.ensure(nv, nt);
    const Wm = o.world, cx = rn.cx, cy = rn.cy, cz = rn.cz;
    for (let i = 0; i < nv; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const wx = Wm[0] * x + Wm[4] * y + Wm[8] * z + Wm[12] - cam.pos[0], wy = Wm[1] * x + Wm[5] * y + Wm[9] * z + Wm[13] - cam.pos[1], wz = Wm[2] * x + Wm[6] * y + Wm[10] * z + Wm[14] - cam.pos[2];
      const X = R[0] * wx + R[3] * wy + R[6] * wz, Y = R[1] * wx + R[4] * wy + R[7] * wz, Z = R[2] * wx + R[5] * wy + R[8] * wz;
      cx[i] = X; cy[i] = Y; cz[i] = Z;
      if (Z > NEAR) { rn.sx[i] = hw + X * zoom / Z; rn.sy[i] = hh + Y * zoom / Z; }
      // environment map coordinates from the camera space normal (texels of a 256x256 texture)
      const nx = Wm[0] * N[i * 3] + Wm[4] * N[i * 3 + 1] + Wm[8] * N[i * 3 + 2], ny = Wm[1] * N[i * 3] + Wm[5] * N[i * 3 + 1] + Wm[9] * N[i * 3 + 2], nz = Wm[2] * N[i * 3] + Wm[6] * N[i * 3 + 1] + Wm[10] * N[i * 3 + 2];
      rn.u[i] = 128 + 127.5 * (R[0] * nx + R[3] * ny + R[6] * nz); rn.v[i] = 128 + 127.5 * (R[1] * nx + R[4] * ny + R[7] * nz);
    }
    if (useBeams) { beams(buf, scene, o, rn, lc, W, H, hw, hh, zoom); continue; }
    // painter sort (1024 z buckets like the original), far to near
    const key = rn.key; let zmax = 1, zmin = 1e30;
    for (let t = 0; t < nt; t++) { const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2]; const z = (rn.cz[a] + rn.cz[b] + rn.cz[c]) / 3; key[t] = z; if (z > zmax) zmax = z; if (z < zmin) zmin = z; }
    const ord = rn.ord, cnt = rn.cnt; cnt.fill(0); const span = (zmax - zmin) || 1, scale = 1023 / span;
    for (let t = 0; t < nt; t++) cnt[1 + (((zmax - key[t]) * scale) | 0)]++;       // bucket 0 = farthest
    for (let i = 0; i < 1024; i++) cnt[i + 1] += cnt[i];
    for (let t = 0; t < nt; t++) ord[cnt[((zmax - key[t]) * scale) | 0]++] = t;
    for (let k = 0; k < nt; k++) {
      const t = ord[k], a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2];
      const sf = m.surfaces[m.tsurf[t]] || m.surfaces[0]; const alpha = sf.opacity;
      if (rn.cz[a] <= NEAR || rn.cz[b] <= NEAR || rn.cz[c] <= NEAR) continue; // ponytail: no near-plane clipping of textured triangles
      const tex = getTex(ctx, sf.texture || 'echo.png', bpp);
      if (sf.mode === 3 && m.uv) { // shading mode 3: plain texture mapping with the vertex uv of the object (vol.lwe); mode 4 = environment map
        const uv = m.uv, ua = uv[a * 2] * 255, va_ = uv[a * 2 + 1] * 255 - 1, ub = uv[b * 2] * 255, vb = uv[b * 2 + 1] * 255 - 1, uc = uv[c * 2] * 255, vc = uv[c * 2 + 1] * 255 - 1;
        if (bpp === 32) triTex32(buf.data, W, H, tex, alpha, rn.sx[a], rn.sy[a], ua, va_, rn.sx[b], rn.sy[b], ub, vb, rn.sx[c], rn.sy[c], uc, vc);
        else if (bpp === 8) triTex8(buf.data, W, H, tex, rn.sx[a], rn.sy[a], ua, va_, rn.sx[b], rn.sy[b], ub, vb, rn.sx[c], rn.sy[c], uc, vc);
        continue;
      }
      if (bpp === 32) triTex32(buf.data, W, H, tex, alpha, rn.sx[a], rn.sy[a], rn.u[a], rn.v[a], rn.sx[b], rn.sy[b], rn.u[b], rn.v[b], rn.sx[c], rn.sy[c], rn.u[c], rn.v[c]);
      else if (bpp === 8) triTex8(buf.data, W, H, tex, rn.sx[a], rn.sy[a], rn.u[a], rn.v[a], rn.sx[b], rn.sy[b], rn.u[b], rn.v[b], rn.sx[c], rn.sy[c], rn.u[c], rn.v[c]);
    }
  }
}

// Shadow-volume "beams": for every triangle the three side quads of the prism extruded away from the light (v + (v-L)*9999) are
// scan converted with the delta filler (+7 at the left edge, -7 at the right edge; prefix sum = `interpolator` effect).
const EXT = 9999, BEAMK = 2; // prism quads are filled with weight 2 (golden SCREEN16 deltas are multiples of 2)
const _ea = new Float64Array(3), _eb = new Float64Array(3), _ec = new Float64Array(3);
function beams(buf, scene, o, rn, L, W, H, hw, hh, zoom) {
  const m = o.mesh, I = m.indices, nt = I.length / 3, cx = rn.cx, cy = rn.cy, cz = rn.cz, dst = buf.data;
  const ex = (i, e) => { e[0] = cx[i] + (cx[i] - L[0]) * EXT; e[1] = cy[i] + (cy[i] - L[1]) * EXT; e[2] = cz[i] + (cz[i] - L[2]) * EXT; };
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    { // back face culling in camera space (the original only queues polygons that pass its visibility test; sign chosen to best match the golden SCREEN16)
      const ux = cx[b] - cx[a], uy = cy[b] - cy[a], uz = cz[b] - cz[a], vx = cx[c] - cx[a], vy = cy[c] - cy[a], vz = cz[c] - cz[a];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * cx[a] + ny * cy[a] + nz * cz[a] < 0) continue;
    }
    ex(a, _ea); ex(b, _eb); ex(c, _ec);
    triDelta16(dst, W, H, 7, rn.sx[a], rn.sy[a], rn.sx[b], rn.sy[b], rn.sx[c], rn.sy[c]); // the object triangle itself (weight 7 with beams on)
    quad(dst, W, H, hw, hh, zoom, BEAMK, cx[a], cy[a], cz[a], cx[b], cy[b], cz[b], _eb, _ea);
    quad(dst, W, H, hw, hh, zoom, BEAMK, cx[a], cy[a], cz[a], cx[c], cy[c], cz[c], _ec, _ea);
    quad(dst, W, H, hw, hh, zoom, BEAMK, cx[b], cy[b], cz[b], cx[c], cy[c], cz[c], _ec, _eb);
  }
}
const _P = new Float64Array(24), _Q = new Float64Array(24), _S0 = new Float64Array(24), _S1 = new Float64Array(24);
// Sutherland-Hodgman clip of a polygon (flat [x0,y0,x1,y1,...]) against one half-plane (0: x>=a, 1: x<=a, 2: y>=a, 3: y<=a)
function clipHalf(src, n, axis, a, dst) {
  let m = 0;
  const inside = (x, y) => axis === 0 ? x >= a : axis === 1 ? x <= a : axis === 2 ? y >= a : y <= a;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, xi = src[i * 2], yi = src[i * 2 + 1], xj = src[j * 2], yj = src[j * 2 + 1];
    const ii = inside(xi, yi), ij = inside(xj, yj);
    if (ii) { dst[m * 2] = xi; dst[m * 2 + 1] = yi; m++; }
    if (ii !== ij) { const c = axis < 2 ? xi : yi, d = axis < 2 ? xj : yj, t = (a - c) / (d - c); dst[m * 2] = xi + (xj - xi) * t; dst[m * 2 + 1] = yi + (yj - yi) * t; m++; }
  }
  return m;
}
function quad(dst, W, H, hw, hh, zoom, k2, x0, y0, z0, x1, y1, z1, e1, e0) {
  // polygon (v0, v1, e1, e0); clip against z >= NEAR in camera space, project, then clip against the screen rectangle
  // with screen-space interpolation (0x60d90/0x8bb50) and fan triangulate.
  _P[0] = x0; _P[1] = y0; _P[2] = z0; _P[3] = x1; _P[4] = y1; _P[5] = z1; _P[6] = e1[0]; _P[7] = e1[1]; _P[8] = e1[2]; _P[9] = e0[0]; _P[10] = e0[1]; _P[11] = e0[2];
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3, az = _P[i * 3 + 2], bz = _P[j * 3 + 2], ain = az >= NEAR, bin = bz >= NEAR;
    if (ain) { _Q[n * 3] = _P[i * 3]; _Q[n * 3 + 1] = _P[i * 3 + 1]; _Q[n * 3 + 2] = az; n++; }
    if (ain !== bin) { const s = (NEAR - az) / (bz - az); _Q[n * 3] = _P[i * 3] + (_P[j * 3] - _P[i * 3]) * s; _Q[n * 3 + 1] = _P[i * 3 + 1] + (_P[j * 3 + 1] - _P[i * 3 + 1]) * s; _Q[n * 3 + 2] = NEAR; n++; }
  }
  if (n < 3) return;
  let m = 0;
  for (let i = 0; i < n; i++) { const z = _Q[i * 3 + 2], iz = z !== 0 ? 1 / z : 0; _S0[m * 2] = hw + _Q[i * 3] * zoom * iz; _S0[m * 2 + 1] = hh + _Q[i * 3 + 1] * zoom * iz; m++; }
  if ((m = clipHalf(_S0, m, 0, 1, _S1)) < 3) return;
  if ((m = clipHalf(_S1, m, 1, W - 1.4, _S0)) < 3) return;
  if ((m = clipHalf(_S0, m, 2, 1, _S1)) < 3) return;
  if ((m = clipHalf(_S1, m, 3, H - 1.4, _S0)) < 3) return;
  for (let i = 1; i + 1 < m; i++) triDelta16(dst, W, H, k2, _S0[0], _S0[1], _S0[i * 2], _S0[i * 2 + 1], _S0[i * 2 + 2], _S0[i * 2 + 3]);
}

// ------------------------------------------------------------------------------------------------ effect `scene`
// params "file speed offset": scene frame = seconds-since-start * speed + offset; the scene restarts when frame-offset >= duration-0.5
FX.register('scene', {
  init(params, ev, ctx) {
    const a = params.trim().split(/\s+/); const file = a[0].toLowerCase();
    const scene = ctx.scenes[file] || (ctx.scenes[file] = loadScene(a[0], '', '', ctx));
    return { scene, file, speed: parseFloat(a[1]) || 1, offset: parseFloat(a[2]) || 0, t0: 0 };
  },
  run(st, ev, ctx) {
    const s = st.scene; const buf = ev.outputs[0] || ev.inputs[0]; if (!buf) return;
    let t = (ev.local - st.t0) * 0.01 * st.speed;
    if (t >= s.duration - 0.5) { st.t0 = ev.local; t = 0; }
    s.width = buf.w; s.height = buf.h; s.evaluate(t + st.offset);
    if (!ctx.render) return;
    renderScene(ctx, s, buf, ctx.beams && s.flag === 'i');
  },
});

// ------------------------------------------------------------------------------------------------ displace247 (0x14c00 / 0x14ee4)
// params "scene object e0 e1 e2": every vertex is moved radially from the object's centroid by
//   v' = c + (v - c) * (1 + e0 * sin(|v - c| * e2 + e1 * Frame))        (e0 amplitude, e1 phase speed per centisecond, e2 spatial frequency)
// (the three expressions are evaluated per frame; assignment of e1/e2 to phase/frequency inferred from the stack usage of 0x14ee4), then the normals are rebuilt (0x5313e).
FX.register('displace247', {
  init(params, ev, ctx) {
    const a = params.trim().split(/\s+/); const scene = getScene(ctx, a[0]); if (!scene) throw new Error('Disp247: Scene (' + a[0] + ') not found');
    const obj = scene.getObject(a[1]); if (!obj) throw new Error('Disp247: Object (' + a[1] + ') not found');
    const P = obj.mesh.positions, n = P.length / 3, c = [0, 0, 0];
    for (let i = 0; i < n; i++) { c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; }
    c[0] /= n; c[1] /= n; c[2] /= n;
    const rel = new Float32Array(n * 3), dist = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = P[i * 3] - c[0], y = P[i * 3 + 1] - c[1], z = P[i * 3 + 2] - c[2]; rel[i * 3] = x; rel[i * 3 + 1] = y; rel[i * 3 + 2] = z; dist[i] = Math.hypot(x, y, z); }
    return { obj, c, rel, dist, out: new Float32Array(n * 3), e: a.slice(2, 5).map((s) => ctx.expr(s)) };
  },
  run(st, ev) {
    const F = ev.local, A = st.e[0](F), speed = st.e[1](F), freq = st.e[2](F), ph = speed * F, n = st.dist.length, o = st.out, r = st.rel, d = st.dist, c = st.c;
    for (let i = 0; i < n; i++) { const s = 1 + A * Math.sin(d[i] * freq + ph); o[i * 3] = r[i * 3] * s + c[0]; o[i * 3 + 1] = r[i * 3 + 1] * s + c[1]; o[i * 3 + 2] = r[i * 3 + 2] * s + c[2]; }
    const m = st.obj.mesh; m.positions = o; m.normals = computeNormals(o, m.indices, true);
  },
});
