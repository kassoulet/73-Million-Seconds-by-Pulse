// node tools/test-raster.mjs - self-check for the texcoord fixups and the x-major walker.
import assert from 'node:assert';
import { degen, triTex32, triDelta16 } from '../docs/js/fx/3d/raster.js';

// degen: >=255 wraps by -255 (original 0xb8ef8)
assert.deepStrictEqual(Array.from(degen(255, 300, 0, 10, 4, 5)), [0, 45, 0, 10, 4, 5]);
assert.deepStrictEqual(Array.from(degen(254.9, 1, 0, 2, 0, 3)), [254.9, 1, 0, 2, 0, 3]);
// degen: all v equal -> one v decremented (original 0xb8f10/14/18), independent ifs
assert.deepStrictEqual(Array.from(degen(1, 7, 1, 7, 1, 7)), [1, 6, 1, 6, 1, 6]); // all u equal -> all v-1
assert.deepStrictEqual(Array.from(degen(1, 7, 1, 7, 5, 7)), [1, 7, 1, 7, 5, 6]); // u0==u1 -> v2-1
assert.deepStrictEqual(Array.from(degen(1, 7, 9, 7, 1, 7)), [1, 7, 9, 6, 1, 7]); // u0==u2 -> v1-1
assert.deepStrictEqual(Array.from(degen(9, 7, 1, 7, 1, 7)), [9, 6, 1, 7, 1, 7]); // u2==u1 -> v0-1
assert.deepStrictEqual(Array.from(degen(1, 7, 1, 8, 1, 7)), [1, 7, 1, 8, 1, 7]); // v not all equal -> unchanged

// triTex32 wraps u=255 to texel 0 (not 255), end-to-end through the span filler
const W = 8, H = 8, tex = new Uint32Array(256 * 256);
tex[255] = 0xff0000; tex[0] = 0x00ff00;
const dst = new Uint32Array(W * H);
triTex32(dst, W, H, tex, 255, 0, 0, 255, 0, 7, 0, 255, 4, 0, 7, 255, 8);
assert.ok(dst.includes(0x00ff00) && !dst.includes(0xff0000), '>=255 must wrap to texel 0');

// near-horizontal triangle -> x-major walker fills the row (triDelta16: +k left, -k right)
const b = new Uint16Array(W * H);
triDelta16(b, W, H, 5, 0, 3, 7, 3, 3.5, 3.9); // y-extent 0.9 < 1
assert.ok(b.some((v) => v !== 0), 'x-major walker must draw a near-horizontal triangle');

// flat top edge (dy ~ 0): must NOT divide by ~0 and spill to the left of the triangle.
// vertices x in [150,157]; nothing may be painted left of 140 (0x3cb851ec guard)
const d2 = new Uint32Array(320 * 200);
triTex32(d2, 320, 200, tex, 255, 150.27, 98.67, 0, 0, 150.10, 92.045, 0, 0, 156.84, 92.047, 0, 0);
for (let y = 0; y < 200; y++) for (let x = 0; x < 140; x++) assert.strictEqual(d2[y * 320 + x], 0, `spill at ${x},${y}`);

// shallow top edge (0.0225 < dy < 1) with a long top edge: y0 < first scanline makes ts negative
// and extrapolates xr far left; must stay inside the triangle's x-range.
const d3 = new Uint32Array(320 * 200);
triTex32(d3, 320, 200, tex, 255, 150, 100.05, 0, 0, 250, 100.1, 0, 0, 150, 110, 0, 0);
for (let y = 0; y < 200; y++) for (let x = 0; x < 145; x++) assert.strictEqual(d3[y * 320 + x], 0, `shallow spill at ${x},${y}`);
console.log('raster self-check OK');
