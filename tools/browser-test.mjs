// node tools/browser-test.mjs [url] [seconds-list e.g. 5,20,60] [outprefix]
// Drives headless Chrome through the DevTools protocol: loads the page, clicks start, seeks to each time, screenshots the canvas, prints console errors.
import { spawn } from 'child_process'; import fs from 'fs';
const url = process.argv[2] || 'http://localhost:18077/index.html';
const times = (process.argv[3] || '5').split(',').map(Number); const prefix = process.argv[4] || '/tmp/shot';
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1100,900', `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/chrome-prof-' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://localhost:${port}/json`)).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url });
for (let i = 0; i < 120; i++) { await sleep(500); if (await ev("!document.getElementById('start').hidden")) break; }
console.log('status:', await ev("document.getElementById('status').textContent"));
await ev("document.getElementById('start').click()"); await sleep(1500);
for (const t of times) {
  await ev(`window.demo.seekTo(${t})`); await sleep(2500);
  const data = await ev("document.getElementById('screen').toDataURL('image/png')");
  fs.writeFileSync(`${prefix}_${t}.png`, Buffer.from(data.split(',')[1], 'base64')); console.log('shot', t, await ev("document.getElementById('time').textContent"));
}
const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(prefix + '_page.png', Buffer.from(shot.result.data, 'base64'));
console.log(logs.filter((l) => !/missing effect/.test(l)).slice(0, 30).join('\n'));
ws.close(); chrome.kill(); process.exit(0);
