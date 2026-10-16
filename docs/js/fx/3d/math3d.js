// math3d.js - small helpers shared by the 3D modules (all row-major 3x3 rotations as Float64Array(9)).

/** LightWave heading/pitch/bank (degrees) -> rotation R = Ry(h) * Rx(p) * Rz(b) (verified against the original camera matrices, error 1e-6). */
export function hpbToMatrix(h, p, b, out) {
  const H = h * Math.PI / 180, P = p * Math.PI / 180, B = b * Math.PI / 180;
  const ch = Math.cos(H), sh = Math.sin(H), cp = Math.cos(P), sp = Math.sin(P), cb = Math.cos(B), sb = Math.sin(B);
  // Ry(h) Rx(p)
  const a00 = ch, a01 = sh * sp, a02 = sh * cp, a10 = 0, a11 = cp, a12 = -sp, a20 = -sh, a21 = ch * sp, a22 = ch * cp;
  // * Rz(b)
  out[0] = a00 * cb + a01 * sb; out[1] = -a00 * sb + a01 * cb; out[2] = a02;
  out[3] = a10 * cb + a11 * sb; out[4] = -a10 * sb + a11 * cb; out[5] = a12;
  out[6] = a20 * cb + a21 * sb; out[7] = -a20 * sb + a21 * cb; out[8] = a22;
  return out;
}
