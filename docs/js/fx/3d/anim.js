// anim.js - keyframe interpolation of the original engine (functions 0x26534 for UNLW scenes, 0x242e0/0x25578 for UEXP).
// Both are Kochanek-Bartels (TCB) Hermite splines with LightWave's frame-spacing correction.

// out[i] = value of channel i at frame t. keys: [{frame, v:Array(n), tension, continuity, bias, linear}] sorted by frame.
// The first key must have frame 0 and the last key frame == lastFrame for the end tangents to match the original
// (first key: outgoing tangent = 0.5*(cp+cn)*(B-A); last key: incoming tangent = 0.5*(cp+cn)*(B-A)).
export function evalKeys(keys, t, out, lastFrame) {
  const n = keys.length, nc = out.length;
  if (n === 1) { for (let i = 0; i < nc; i++) out[i] = keys[0].v[i]; return out; }
  if (lastFrame === undefined) lastFrame = keys[n - 1].frame;
  // segment search of the original: advance while next.frame < t (stops on the last real key)
  let a = 0;
  while (a < n - 1 && keys[a + 1].frame < t) a++;
  if (a >= n - 1) { // past the last key: the original runs into its sentinel copy of the last key -> hold the last value
    for (let i = 0; i < nc; i++) out[i] = keys[n - 1].v[i];
    return out;
  }
  const A = keys[a], B = keys[a + 1];
  const N1 = B.frame - A.frame;
  const u = N1 ? (t - A.frame) / N1 : 0;
  if (B.linear) { for (let i = 0; i < nc; i++) out[i] = A.v[i] + u * (B.v[i] - A.v[i]); return out; }
  const u2 = u * u, u3 = u2 * u;
  const h1 = 2 * u3 - 3 * u2 + 1, h2 = -2 * u3 + 3 * u2, h3 = u3 - 2 * u2 + u, h4 = u3 - u2;
  // coefficient pairs
  const Ta = A.tension || 0, Ca = A.continuity || 0, Ba = A.bias || 0;
  const Tb = B.tension || 0, Cb = B.continuity || 0, Bb = B.bias || 0;
  const aP = (1 - Ta) * (1 + Ca) * (1 + Ba), aN = (1 - Ta) * (1 - Ca) * (1 - Ba);
  const bP = (1 - Tb) * (1 - Cb) * (1 + Bb), bN = (1 - Tb) * (1 + Cb) * (1 - Bb);
  const first = A.frame === 0 || a === 0, last = B.frame === lastFrame || a + 1 === n - 1;
  const prev = first ? null : keys[a - 1], next = last ? null : keys[a + 2];
  const sA = prev ? N1 / (B.frame - prev.frame) : 0, sB = next ? N1 / (next.frame - A.frame) : 0;
  for (let i = 0; i < nc; i++) {
    const d = B.v[i] - A.v[i];
    const tsA = prev ? 0.5 * (aP * (A.v[i] - prev.v[i]) + aN * d) * 2 * sA : 0.5 * (aP + aN) * d;
    const tdB = next ? 0.5 * (bP * d + bN * (next.v[i] - B.v[i])) * 2 * sB : 0.5 * (bP + bN) * d;
    out[i] = h1 * A.v[i] + h2 * B.v[i] + h3 * tsA + h4 * tdB;
  }
  return out;
}
