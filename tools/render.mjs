// node tools/render.mjs <seconds> [out.ppm] [--warm=1.5]   - render the demo at time t headlessly (for testing effects)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Engine } = await import(root + '/docs/js/engine.js');
const { xmTimeline } = await import(root + '/docs/js/xmtime.js');
await import(root + '/docs/js/fx/index.js');
const A = root + '/docs/assets/', R = root + '/build/raw/';
const meta = JSON.parse(fs.readFileSync(R + 'meta.json'));
const assets = {
  text: (n) => fs.readFileSync(A + n, 'utf8'),
  bin: (n) => new Uint8Array(fs.readFileSync(A + n)),
  image(n) { // n like 'sleep.tga' -> sleep.png ; jpg stays jpg
    let f = n.replace(/\.tga$/i, '.png').replace(/\.unr$/i, '.png').toLowerCase();
    if (!meta[f]) throw new Error('no image ' + n);
    const b = fs.readFileSync(R + f + '.rgb32'); return { w: meta[f][0], h: meta[f][1], rgb: new Uint32Array(b.buffer, b.byteOffset, b.length >> 2).slice() };
  },
  idx(n) { const b = n.replace(/\.tga$/i, ''); const data = new Uint8Array(fs.readFileSync(A + b + '.idx'));
    const p = A + b + '.tgapal'; return { w: 256, h: 256, data, pal: fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null }; },
};
const xm = fs.readFileSync(A + 'tour2.xm'); const tl = xmTimeline(xm.buffer.slice(xm.byteOffset, xm.byteOffset + xm.length));
const eng = new Engine(assets, assets.text('script.unr'), tl);
const t = parseFloat(process.argv[2] ?? '0'); const out = process.argv[3] ?? 'frame.ppm';
const warm = parseFloat((process.argv.find((a) => a.startsWith('--warm=')) || '--warm=1.5').slice(7));
const t0 = Date.now(); const scr = eng.seek(t, warm); console.log('rendered t=' + t + 's in ' + (Date.now() - t0) + 'ms; duration', tl.duration.toFixed(1), 'end', eng.endTime.toFixed(1));
const hdr = `P6\n${scr.w} ${scr.h}\n255\n`; const px = Buffer.alloc(scr.w * scr.h * 3);
for (let i = 0; i < scr.data.length; i++) { const v = scr.data[i]; px[i * 3] = (v >> 16) & 255; px[i * 3 + 1] = (v >> 8) & 255; px[i * 3 + 2] = v & 255; }
fs.writeFileSync(out, Buffer.concat([Buffer.from(hdr), px]));
