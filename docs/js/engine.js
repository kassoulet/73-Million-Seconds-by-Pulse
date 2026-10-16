// engine.js - script interpreter + event scheduler (port of the demo's "unr" engine).
import { Buf, FX, compileExpr } from './core.js';
import { timeOf } from './xmtime.js';

export const Hooks = { loadScene: null, loadAnim: null }; // set by 3D / anim modules

/** Parse script.unr. Lines may start with "<order> <row>" (new time) or continue the previous time. */
export function parseScript(text) {
  const cmds = []; let order = 0, row = 0;
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line[0] === ';') continue;
    if (line[0] === '@') break;
    const m = /^(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (m) { order = +m[1]; row = +m[2]; line = m[3]; }
    const sp = line.search(/\s/);
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    cmds.push({ order, row, cmd, rest, line });
  }
  return cmds;
}

function groups(s) { // "{a b} {c} {}" -> ["a b","c",""]
  const out = []; const re = /\{([^}]*)\}/g; let m;
  while ((m = re.exec(s))) out.push(m[1].trim());
  return out;
}

export class Engine {
  /** assets: { text(name), image(name)->{w,h,rgb:Uint32Array}, idx(name)->{w,h,data,pal}, bin(name)->Uint8Array } */
  constructor(assets, scriptText, timeline) {
    this.assets = assets; this.cmds = parseScript(scriptText); this.tl = timeline;
    this.cmdTimes = this.cmds.map((c) => timeOf(timeline, c.order, c.row));
    const endCmd = this.cmds.findIndex((c) => c.cmd === 'theend');
    this.endTime = endCmd >= 0 ? this.cmdTimes[endCmd] : timeline.duration;
    this.reset();
  }
  reset() {
    this.bufs = Object.create(null); this.events = []; this.next = 0; this.seq = 0;
    this.scenes = Object.create(null); this.anims = Object.create(null);
    this.ctx = {
      engine: this, assets: this.assets, bufs: this.bufs, scenes: this.scenes, anims: this.anims,
      time: 0, frame: 0, control: 0, lwotr: 255, lwoshading: 4, beams: false, render: true,
      expr: compileExpr, buf: (n) => this.buf(n),
    };
  }
  buf(name) { return this.bufs[name.toUpperCase()]; }

  /** Execute all script commands due at time t (seconds). */
  _exec(t) {
    while (this.next < this.cmds.length && this.cmdTimes[this.next] <= t + 1e-9) {
      const i = this.next++; this._run(this.cmds[i], this.cmdTimes[i]);
    }
  }
  _run(c, tc) {
    const ctx = this.ctx, a = c.rest.split(/\s+/);
    switch (c.cmd) {
      case 'createbuffer': { // name w h bpp [file]
        const [name, w, h, bpp, file] = a; const b = new Buf(name.toUpperCase(), +w, +h, +bpp);
        if (file) this._fill(b, file);
        this.bufs[b.name] = b; break;
      }
      case 'loadscene': { // file buffer flag
        if (Hooks.loadScene) this.scenes[a[0].toLowerCase()] = Hooks.loadScene(a[0], a[1], a[2], ctx);
        break;
      }
      case 'loadanim': { if (Hooks.loadAnim) this.anims[a[0].toLowerCase()] = Hooks.loadAnim(a[0], a[1], ctx); break; }
      case 'addevent': {
        const m = /^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(c.rest);
        const g = groups(m[4]); const impl = FX.get(m[2]);
        const ev = { layer: +m[1], type: m[2].toLowerCase(), name: m[3], seq: this.seq++, t0: tc * 100,
          inputs: this._bl(g[0]), outputs: this._bl(g[1]), groups: g, impl, state: null, suppressed: false, local: 0 };
        if (!impl) { ev.missing = true; if (!Engine.warned[ev.type]) { Engine.warned[ev.type] = 1; console.warn('missing effect', ev.type); } }
        else ev.state = impl.init ? impl.init(g[2] || '', ev, ctx) : null;
        this.events.push(ev); this.events.sort((p, q) => p.layer - q.layer || p.seq - q.seq); break;
      }
      case 'deleteevent': {
        const [l, n] = a; const i = this.events.findIndex((e) => e.layer === +l && e.name.toLowerCase() === n.toLowerCase());
        if (i >= 0) { const e = this.events[i]; if (e.impl && e.impl.free) e.impl.free(e.state, e, ctx); this.events.splice(i, 1); }
        break;
      }
      case 'changebuffers': { // layer name {in} {out}
        const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(c.rest); const g = groups(m[3]);
        const e = this.events.find((x) => x.layer === +m[1] && x.name.toLowerCase() === m[2].toLowerCase());
        if (e) { e.inputs = this._bl(g[0]); e.outputs = this._bl(g[1]); }
        break;
      }
      case 'suppressevent': case 'resumeevent': {
        const e = this.events.find((x) => x.layer === +a[0] && x.name.toLowerCase() === a[1].toLowerCase());
        if (e) e.suppressed = c.cmd === 'suppressevent'; break;
      }
      case 'controlfloat': ctx.control = parseFloat(a[0]); break;
      case 'lwotr': ctx.lwotr = +a[0]; break;
      case 'lwoshading': ctx.lwoshading = +a[0]; break;
      case 'beamson': ctx.beams = true; break;
      case 'beamsoff': ctx.beams = false; break;
      case 'renderoff': ctx.render = false; break;
      case 'renderon': ctx.render = true; break;
      case 'theend': this.ended = true; break;
      default: break; // listaevents, setwireframe... ignored
    }
  }
  _bl(s) { return (s || '').split(/\s+/).filter(Boolean).map((n) => this.buf(n)).filter(Boolean); }
  _fill(b, file) {
    const f = file.toLowerCase(), A = this.assets;
    if (b.bpp === 8) { const im = A.idx(f); b.data.set(im.data.subarray(0, b.data.length)); b.pal = im.pal; return; }
    const im = A.image(f); // 32-bit RGB source, resample if needed (all demo images already match)
    if (b.bpp === 32) b.data.set(im.rgb.subarray(0, b.data.length));
    else if (b.bpp === 16) for (let i = 0; i < b.data.length; i++) { const p = im.rgb[i]; b.data[i] = ((p >> 8) & 0xf800) | ((p >> 5) & 0x7e0) | ((p >> 3) & 31); }
  }

  /** Run one frame at music time t (seconds). Returns the SCREEN buffer. */
  update(t) {
    const ctx = this.ctx; ctx.time = t; ctx.frame = t * 100;
    this._exec(t);
    for (const ev of this.events) {
      if (ev.suppressed || !ev.impl || !ev.impl.run) continue;
      ev.local = ctx.frame - ev.t0;
      ev.impl.run(ev.state, ev, ctx);
    }
    return this.bufs.SCREEN;
  }
  /** Jump to time t: rebuild state by replaying the script, with a short warm-up for feedback effects. */
  seek(t, warm = 1.5, fps = 30) {
    this.reset();
    const from = Math.max(0, t - warm);
    this._exec(from - 1e-6 > 0 ? from - 1e-6 : 0);
    for (let tt = from; tt < t; tt += 1 / fps) this.update(tt);
    return this.update(t);
  }
}
Engine.warned = {};
