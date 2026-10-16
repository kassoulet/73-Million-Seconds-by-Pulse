// formats.js - parsers for the three 3D file formats of "73 million seconds".
// Reverse engineered from the loaders in 73MS.EXE: loadlws.c (0x1bf7c: UNLW scenes), the LWV object loader
// (0x1cacc), loaduexp.c (0x1f02f: UEXP scenes). All numbers are little endian. Pure data, no rendering.

const td = new TextDecoder('latin1');
const cstr = (u8, o, n) => { let e = o; const end = o + n; while (e < end && u8[e]) e++; return td.decode(u8.subarray(o, e)); };

/** One motion key of a LightWave-style channel group (UNLW). 44 bytes in the file:
 *  6 floats (x y z heading pitch bank, degrees), int frame, int linear, 3 floats (tension continuity bias). */
function readLweKeys(dv, p, n) {
  const keys = [];
  for (let i = 0; i < n; i++, p += 44) {
    const v = new Float64Array(6);
    for (let k = 0; k < 6; k++) v[k] = dv.getFloat32(p + 4 * k, true);
    keys.push({ v, frame: dv.getInt32(p + 24, true), linear: dv.getInt32(p + 28, true) !== 0,
      tension: dv.getFloat32(p + 32, true), continuity: dv.getFloat32(p + 36, true), bias: dv.getFloat32(p + 40, true) });
  }
  return [keys, p];
}

/** Parse a UNLW scene (aziz1.lwe, obj1.lwe, scene.lwe, vol.lwe).
 *  Layout: "UNLW" then chunks <u8 id> ... , id 0xff ends, followed by a 24 byte trailer.
 *   id 1 object  : char name[13] (".lwo" -> loads the ".lwv" file of that name), i32 nkeys, key[nkeys]
 *   id 4 null    : same layout as object but without geometry
 *   id 2 camera  : i32 nkeys, key[nkeys]                          (zoom is fixed, see Scene3D.camera)
 *   id 3 light   : i32 nkeys, key[nkeys], u8 r,g,b
 *   id 11        : per-object surface override (not used by the shipped files)
 *  trailer: u32 nObjects, nNulls, nCameras, nLights, i32 duration(frames), float(30.0)
 */
export function parseLWE(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (cstr(u8, 0, 4) !== 'UNLW') throw new Error('not a UNLW file');
  const S = { kind: 'lwe', objects: [], nulls: [], cameras: [], lights: [], duration: 0, fps: 30 };
  let p = 5, id = u8[4];
  while (id !== 0xff && p < u8.length) {
    if (id === 1 || id === 4) {
      const name = cstr(u8, p, 13), n = dv.getInt32(p + 13, true); p += 17;
      let keys; [keys, p] = readLweKeys(dv, p, n);
      (id === 1 ? S.objects : S.nulls).push({ name, keys });
    } else if (id === 2) {
      const n = dv.getInt32(p, true); p += 4; let keys; [keys, p] = readLweKeys(dv, p, n); S.cameras.push({ keys });
    } else if (id === 3) {
      const n = dv.getInt32(p, true); p += 4; let keys; [keys, p] = readLweKeys(dv, p, n);
      S.lights.push({ keys, color: [u8[p], u8[p + 1], u8[p + 2]] }); p += 3;
    } else if (id === 11) { // object modifier record (75 bytes) attached to the previous object, only in scene.lwe (never played)
      (S.objects[S.objects.length - 1] || {}).modifier = u8.slice(p, p + 75); p += 75;
    } else throw new Error('UNLW: unknown chunk ' + id + ' at ' + (p - 1));
    id = u8[p++];
  }
  S.duration = dv.getInt32(p + 16, true); // trailer at p..p+23: counts (4 x u32), duration, float 30.0
  return S;
}

/** Parse an LWV object (aziz_2.lwv, obj11.lwv, p_u.lwv, particl3.lwv): converted LightWave object.
 *  u32 nVerts, u32 nTris, u32 nSurfs; nVerts * {float x y z u v}; nSurfs * {char name[32], char texture[32], u8 r g b, u8 a, u8 b, u8 c};
 *  nTris * {i16 v0 v1 v2 surface}. UVs are per vertex. */
export function parseLWV(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const nv = dv.getUint32(0, true), nt = dv.getUint32(4, true), ns = dv.getUint32(8, true);
  const positions = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let p = 12;
  for (let i = 0; i < nv; i++, p += 20) {
    positions[i * 3] = dv.getFloat32(p, true); positions[i * 3 + 1] = dv.getFloat32(p + 4, true); positions[i * 3 + 2] = dv.getFloat32(p + 8, true);
    uv[i * 2] = dv.getFloat32(p + 12, true); uv[i * 2 + 1] = dv.getFloat32(p + 16, true);
  }
  const surfaces = [];
  for (let i = 0; i < ns; i++, p += 70) {
    surfaces.push({ name: cstr(u8, p, 32), texture: cstr(u8, p + 32, 32).toLowerCase(), color: [u8[p + 64], u8[p + 65], u8[p + 66]], extra: [u8[p + 67], u8[p + 68], u8[p + 69]] });
  }
  const indices = new Uint32Array(nt * 3), tsurf = new Uint16Array(nt);
  for (let i = 0; i < nt; i++, p += 8) {
    indices[i * 3] = dv.getInt16(p, true); indices[i * 3 + 1] = dv.getInt16(p + 2, true); indices[i * 3 + 2] = dv.getInt16(p + 4, true);
    tsurf[i] = dv.getInt16(p + 6, true);
  }
  return { positions, uv, indices, tsurf, surfaces };
}

/** Parse a UEXP scene (smoke.exp, box2.exp, box3.exp): export of a 3D Studio MAX scene.
 *  u32 magic 'UEXP', u32 nObjects, nCameras, nNulls, nLights, nParticles, nMaterials, float duration(frames);
 *  materials : char name[16], char texture[5][13], float[9] (ambient rgb, diffuse rgb, specular rgb), u8 shininess, u8 opacity, u8 mode, u8 flags
 *  objects   : char name[16], u32 nVerts nUV nTris k0..k3 flags, [char parent[16] if flags&0x4000], u16 parent, u16 pad,
 *              float[12] node TM (3 rows of axes + translation), float[3] pivot, float[3] * nVerts (world space),
 *              float[2] * nUV, {i32 v0 v1 v2 material} * nTris, {i32 uv0 uv1 uv2} * nTris (if nUV), float[3] scale,
 *              u32 n, n * {float[6] ? , float, i32}  (rotation keys: quaternion-ish), u32 n, n * posKey
 *  posKey    : {i32/float frame, float x y z, float a b, i32 flags} (28 bytes), a/b = tension/continuity
 *  cameras   : posKeys, targetKeys, fov keys {i32 frame, float}, roll keys {i32 frame, float}
 *  lights    : char name[16], float rgb[3], float[2] (attenuation start/end), u32 type, posKeys
 */
export function parseEXP(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (cstr(u8, 0, 4) !== 'UEXP') throw new Error('not a UEXP file');
  let p = 4;
  const u = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const i = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const f = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const nObj = u(), nCam = u(), nNull = u(), nLight = u(), nPart = u(), nMat = u();
  const S = { kind: 'exp', objects: [], nulls: [], cameras: [], lights: [], materials: [], duration: f(), fps: 30, nParticles: nPart };
  const posKeys = (n) => { const a = []; for (let k = 0; k < n; k++) { const frame = f(); const v = [f(), f(), f()]; const t = f(), c = f(); const lin = i(); a.push({ frame, v, tension: t, continuity: c, linear: lin !== 0 }); } return a; };
  const valKeys = (n) => { const a = []; for (let k = 0; k < n; k++) { a.push({ frame: i(), value: f() }); } return a; };
  for (let m = 0; m < nMat; m++) {
    const name = cstr(u8, p, 16); const tex = []; for (let k = 0; k < 5; k++) tex.push(cstr(u8, p + 16 + 13 * k, 13).toLowerCase()); p += 81;
    const col = []; for (let k = 0; k < 9; k++) col.push(f());
    S.materials.push({ name, texture: tex[0], ambient: col.slice(0, 3), diffuse: col.slice(3, 6), specular: col.slice(6, 9),
      shininess: u8[p], opacity: u8[p + 1], mode: u8[p + 2], flags: u8[p + 3] }); p += 4;
  }
  for (let o = 0; o < nObj; o++) {
    const name = cstr(u8, p, 16); p += 16;
    const nv = u(), nuv = u(), nt = u(); p += 16; const flags = u();
    let parentName = ''; if ((flags >> 8) & 0x40) { parentName = cstr(u8, p, 16); p += 16; }
    const parent = dv.getUint16(p, true); p += 4;
    const tm = []; for (let k = 0; k < 12; k++) tm.push(f());
    const pivot = [f(), f(), f()];
    const positions = new Float32Array(nv * 3); for (let k = 0; k < nv * 3; k++) positions[k] = f();
    const uvs = new Float32Array(nuv * 2); for (let k = 0; k < nuv * 2; k++) uvs[k] = f();
    const indices = new Uint32Array(nt * 3), tmat = new Uint16Array(nt);
    for (let k = 0; k < nt; k++) { indices[k * 3] = i(); indices[k * 3 + 1] = i(); indices[k * 3 + 2] = i(); tmat[k] = i(); }
    let triUV = null; if (nuv) { triUV = new Uint32Array(nt * 3); for (let k = 0; k < nt * 3; k++) triUV[k] = i(); }
    const scale = [f(), f(), f()];
    let n = u(); const rot = []; for (let k = 0; k < n; k++) { const q = [f(), f(), f(), f(), f(), f()]; const a = f(); const fr = i(); rot.push({ q, a, frame: fr }); }
    n = u(); const pos = posKeys(n);
    S.objects.push({ name, parentName, parent: parent === 0xffff ? -1 : parent, flags, tm, pivot, positions, uvs, indices, tmat, triUV, scale, rot, pos });
  }
  for (let c = 0; c < nCam; c++) {
    const pos = posKeys(u()); const target = posKeys(u()); const fov = valKeys(u()); const roll = valKeys(u());
    S.cameras.push({ pos, target, fov, roll });
  }
  for (let l = 0; l < nLight; l++) {
    const name = cstr(u8, p, 16); p += 16; const color = [f(), f(), f()]; const range = [f(), f()]; const type = u();
    S.lights.push({ name, color, range, type, pos: posKeys(u()) });
  }
  if (p !== u8.length) console.warn('UEXP: ' + (u8.length - p) + ' unparsed bytes');
  return S;
}
