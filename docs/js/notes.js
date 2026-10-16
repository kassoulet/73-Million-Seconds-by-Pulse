// notes.js - injects the per-effect documentation fragments (docs/notes/*.html) into the page.
const host = document.getElementById('notes');
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function hiAsm(pre) { // address column + ; comments
  const raw = pre.textContent;
  pre.innerHTML = raw.split('\n').map((l) => {
    const m = /^(\s*[0-9a-fA-F]{3,8}[:\s])(.*)$/.exec(l); let a = '', rest = l;
    if (m) { a = '<span class="ad">' + esc(m[1]) + '</span>'; rest = m[2]; }
    const i = rest.indexOf(';');
    return a + (i < 0 ? esc(rest) : esc(rest.slice(0, i)) + '<span class="c">' + esc(rest.slice(i)) + '</span>');
  }).join('\n');
}
(async () => {
  try {
    const idx = await (await fetch('notes/index.json')).json();
    if (!idx.length) { host.innerHTML = '<p class="dim">Notes are being written.</p>'; return; }
    host.innerHTML = '';
    for (const f of idx) {
      const r = await fetch('notes/' + f); if (!r.ok) continue;
      const d = document.createElement('div'); d.className = 'note'; d.innerHTML = await r.text();
      d.querySelectorAll('pre.asm').forEach(hiAsm);
      host.appendChild(d);
    }
  } catch (e) { host.innerHTML = '<p class="dim">Notes unavailable (' + esc(String(e.message)) + ').</p>'; }
})();
