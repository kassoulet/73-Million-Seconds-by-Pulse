// core.js - shared types for the "73 million seconds" JS port.
// Effects register themselves in FX; the engine (engine.js) drives them.

/** Pixel buffer. 8 bit = Uint8Array palette index, 16 bit = Uint16Array (RGB565),
 *  32 bit = Uint32Array 0x00RRGGBB. */
export class Buf {
  constructor(name, w, h, bpp) {
    this.name = name; this.w = w; this.h = h; this.bpp = bpp;
    this.data = bpp === 8 ? new Uint8Array(w * h) : bpp === 16 ? new Uint16Array(w * h) : new Uint32Array(w * h);
    this.pal = null; // optional Uint8Array(768) RGB 0..255 (set by 'palette'-like effects if they need it)
  }
}

/** Effect registry. impl = { init(params, ev, ctx) -> state, run(state, ev, ctx), free?(state, ev, ctx) } */
export const FX = {
  registry: Object.create(null),
  register(name, impl) { this.registry[name.toLowerCase()] = impl; },
  get(name) { return this.registry[name.toLowerCase()]; },
};

// ---- expression evaluator (script params like "1.0-clip10(Frame*0.003)") ----
// Frame = centiseconds since the event started (the original reads the IMS module clock * 100).
const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  fabs: Math.abs, abs: Math.abs, sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil,
  sqr: (x) => x * x,
  clip10: (x) => (x < 0 ? 0 : x > 1 ? 1 : x),
  clip11: (x) => (x < -1 ? -1 : x > 1 ? 1 : x),
  clip: (x, a, b) => (x < a ? a : x > b ? b : x),
};
const cache = new Map();
/** compileExpr("sin(Frame*0.01)") -> (frame:number, extra?:object) => number */
export function compileExpr(src) {
  let f = cache.get(src);
  if (f) return f;
  const js = src.replace(/[A-Za-z_][A-Za-z_0-9]*/g, (id) => {
    const l = id.toLowerCase();
    if (l === 'frame') return 'Frame';
    if (l === 'pi') return 'Math.PI';
    if (l in FUNCS) return 'F.' + l;
    if (/^e\d*$/i.test(id)) return id; // 1e-3 style exponents
    throw new Error('unknown identifier in expression: ' + id + ' in ' + src);
  });
  const fn = new Function('F', 'Frame', 'return (' + js + ');');
  f = (frame) => fn(FUNCS, frame);
  cache.set(src, f);
  return f;
}
