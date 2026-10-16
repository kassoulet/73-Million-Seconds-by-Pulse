// xmtime.js - walk an FT2 .xm file and return the start time (seconds) of every (order,row).
// The original demo is scripted in (order,row) pairs read from its module player (IMS), and the
// per-event "Frame" clock is that player's time * 100. We need the same timeline in JS.
export function xmTimeline(buf) {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  const hdr = 60, hsize = d.getUint32(hdr, true);
  const songLen = d.getUint16(hdr + 4, true), nch = d.getUint16(hdr + 8, true), npat = d.getUint16(hdr + 10, true);
  let speed = d.getUint16(hdr + 16, true), bpm = d.getUint16(hdr + 18, true);
  const orders = Array.from(u8.subarray(hdr + 20, hdr + 20 + songLen));
  // patterns: unpack effect columns only
  let p = hdr + hsize;
  const pats = [];
  for (let i = 0; i < npat; i++) {
    const hl = d.getUint32(p, true), rows = d.getUint16(p + 5, true), ps = d.getUint16(p + 7, true);
    let q = p + hl; const end = q + ps; const fx = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < nch; c++) {
        let b = 0, et = 0, ep = 0;
        if (q >= end) { row.push([0, 0]); continue; }
        const f = u8[q++];
        if (f & 0x80) {
          if (f & 1) q++; if (f & 2) q++; if (f & 4) q++;
          if (f & 8) et = u8[q++]; if (f & 16) ep = u8[q++];
        } else { q += 4; et = u8[q++]; ep = u8[q++]; }
        row.push([et, ep]);
      }
      fx.push(row);
    }
    pats.push(fx); p = end;
  }
  const times = []; // times[order][row]
  let t = 0;
  for (let o = 0; o < songLen; o++) {
    const fx = pats[orders[o]] || [];
    const n = fx.length || 64; times[o] = [];
    let r = 0, jumpTo = -1;
    for (; r < n; r++) {
      times[o][r] = t;
      let brk = -1;
      for (const [et, ep] of fx[r] || []) {
        if (et === 0xf) { if (ep < 0x20) speed = ep || speed; else bpm = ep; }
        else if (et === 0xd) brk = (ep >> 4) * 10 + (ep & 15);
      }
      t += speed * 2.5 / bpm;
      if (brk >= 0) { jumpTo = brk; r++; break; }
    }
    for (; r < n; r++) times[o][r] = t; // skipped rows share the end time
  }
  return { times, duration: t, songLen, orders };
}
export function timeOf(tl, order, row) {
  const o = Math.min(order, tl.songLen - 1);
  const r = tl.times[o];
  return r ? (r[Math.min(row, r.length - 1)] ?? tl.duration) : tl.duration;
}
