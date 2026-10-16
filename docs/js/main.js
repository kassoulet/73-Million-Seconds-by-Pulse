// main.js - browser player for the JS port of "73 million seconds".
import { Engine } from './engine.js';
import { xmTimeline, timeOf } from './xmtime.js';
import { loadAssets } from './assets.js';
import { ChiptuneJsPlayer } from '../vendor/chiptune3/chiptune3.js';
import './fx/index.js';

// Chapters = (order,row) where a new part starts in script.unr
const CHAPTERS = [
  [0, 0, 'Glass sculpture'], [3, 5, 'Radial blur & logo'], [5, 0, 'Nebar fly-through'], [7, 0, 'P_U particles'],
  [11, 50, 'Parasite'], [12, 60, 'Smoke & flares'], [15, 16, 'Marching cubes'], [17, 12, 'Echo atoms'],
  [19, 0, 'Echo tunnels'], [23, 0, 'Echo, matrix & blobs'], [26, 0, 'Displaced sculpture'], [29, 0, 'Medusa'],
  [30, 0, 'Credits'], [32, 0, 'Cubes & sprites'],
];

const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

const canvas = $('screen'), g = canvas.getContext('2d', { alpha: false });
const img = g.createImageData(320, 200), px32 = new Uint32Array(img.data.buffer);
const stage = $('stage');

let eng = null, tl = null, xmData = null, chapters = [], player = null, ctxA = null;
let playing = false, started = false, tBase = 0, tWall = 0, lastT = -1, lastPos = null, silent = true, muted = false;
let showHud = false;

const now = () => performance.now() / 1000;
const curT = () => (playing ? tBase + (now() - tWall) : tBase);
function setT(t) { tBase = t; tWall = now(); }

function present(scr) {
  const d = scr.data;
  for (let i = 0; i < 64000; i++) { const v = d[i]; px32[i] = 0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255); }
  g.putImageData(img, 0, 0);
}

function status(msg) { $('status').textContent = msg; }

async function boot() {
  status('loading assets…');
  const assets = await loadAssets('assets/', (p) => { $('bar').style.width = (p * 100 | 0) + '%'; });
  xmData = await (await fetch('assets/tour2.xm')).arrayBuffer();
  tl = xmTimeline(xmData);
  eng = new Engine(assets, assets.text('script.unr'), tl);
  chapters = CHAPTERS.map(([o, r, n]) => ({ t: timeOf(tl, o, r), name: n }));
  const seek = $('seek'); seek.max = String(Math.ceil(eng.endTime * 10));
  const marks = $('marks'); marks.innerHTML = '';
  chapters.forEach((c, i) => { const m = document.createElement('i'); m.style.left = (c.t / eng.endTime * 100) + '%'; m.title = c.name; marks.appendChild(m); });
  eng.seek(0); present(eng.bufs.SCREEN);
  $('loading').hidden = true; $('start').hidden = false; status('ready');
}

async function startAudio() {
  silent = true;
  try {
    player = new ChiptuneJsPlayer({ repeatCount: 0 });
    ctxA = player.context;
    await new Promise((res, rej) => { player.onInitialized(res); setTimeout(() => rej(new Error('audio init timeout')), 8000); });
    player.onProgress((m) => { lastPos = { pos: m.pos, at: now() }; });
    player.onEnded(() => { if (curT() > eng.endTime - 3) end(); });
    player.play(xmData.slice(0));
    silent = false;
  } catch (e) { console.warn('audio unavailable, running silent:', e); silent = true; }
}

function end() { playing = false; setT(0); eng.seek(0); present(eng.bufs.SCREEN); lastT = 0; ui(); status('end — press play to watch again'); if (player && !silent) { player.setPos(0); player.pause(); } }

async function play() {
  if (!started) { started = true; $('start').hidden = true; await startAudio(); setT(0); eng.seek(0); lastT = -1; }
  else if (!silent) player.unpause();
  setT(curT()); playing = true; ui();
}
function pause() { setT(curT()); playing = false; lastPos = null; if (!silent) player.pause(); ui(); }
function toggle() { playing ? pause() : play(); }
function seekTo(t) {
  t = Math.min(Math.max(0, t), eng.endTime - 0.05);
  const was = playing; setT(t);
  if (started && !silent) { player.setPos(t); lastPos = null; }
  $('busy').hidden = false;
  setTimeout(() => { eng.seek(t); lastT = t; present(eng.bufs.SCREEN); $('busy').hidden = true; if (!was && started) { /* stay paused */ } }, 0);
}
function chapterIndex(t) { let k = 0; chapters.forEach((c, i) => { if (t >= c.t - 0.001) k = i; }); return k; }
function step(dir) {
  const t = curT(), k = chapterIndex(t);
  if (dir < 0) seekTo(t - chapters[k].t > 2 ? chapters[k].t : chapters[Math.max(0, k - 1)].t);
  else seekTo(chapters[Math.min(chapters.length - 1, k + 1)].t);
}

function ui() {
  $('play').textContent = playing ? '⏸' : '▶'; $('play').title = playing ? 'Pause (space)' : 'Play (space)';
  stage.classList.toggle('paused', started && !playing);
}

let lastHud = 0;
function frame() {
  requestAnimationFrame(frame);
  if (!eng || !started) return;
  let t = curT();
  if (!silent && playing && lastPos) { // keep the visual clock locked to the module clock
    const age = now() - lastPos.at;
    const a = lastPos.pos + age - (ctxA ? (ctxA.outputLatency || 0) + (ctxA.baseLatency || 0) : 0);
    if (age > 0.5) { /* stale (just resumed) */ } else if (Math.abs(a - t) > 0.12) { setT(a); t = a; } else { setT(t + (a - t) * 0.1); t = curT(); }
  }
  if (t >= eng.endTime) { end(); return; }
  if (playing) {
    if (lastT < 0 || t < lastT - 1e-6 || t - lastT > 1.0) { eng.seek(t); } else eng.update(t);
    lastT = t; present(eng.bufs.SCREEN);
  }
  const k = chapterIndex(t);
  $('time').textContent = fmt(t) + ' / ' + fmt(eng.endTime);
  $('chap').textContent = (k + 1) + '/' + chapters.length + ' · ' + chapters[k].name;
  const sk = $('seek'); if (document.activeElement !== sk) sk.value = String(Math.round(t * 10));
  if (showHud && now() - lastHud > 0.25) {
    lastHud = now();
    $('hud').textContent = 'order ' + orderRow(t) + '\n' + eng.events.map((e) => `L${e.layer} ${e.type} ${e.name}${e.missing ? ' (not ported)' : ''}`).join('\n');
  }
}
function orderRow(t) { let o = 0; while (o + 1 < tl.songLen && tl.times[o + 1][0] <= t) o++; let r = 0; const a = tl.times[o]; while (r + 1 < a.length && a[r + 1] <= t) r++; return o + ':' + String(r).padStart(2, '0'); }

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
}

$('start').addEventListener('click', play);
$('play').addEventListener('click', toggle);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('fs').addEventListener('click', fullscreen);
canvas.addEventListener('click', () => (started ? toggle() : play()));
canvas.addEventListener('dblclick', fullscreen);
$('seek').addEventListener('change', (e) => seekTo(+e.target.value / 10));
$('vol').addEventListener('input', (e) => { if (player) player.setVol(+e.target.value); });
$('scan').addEventListener('change', (e) => stage.classList.toggle('scan', e.target.checked));
$('hudb').addEventListener('change', (e) => { showHud = e.target.checked; $('hud').hidden = !showHud; });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (!eng) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'f' || e.key === 'F') fullscreen();
  else if (e.key === 'l') seekTo(curT() + 5);
  else if (e.key === 'j') seekTo(curT() - 5);
});
document.querySelectorAll('[data-chapter]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const i = +a.dataset.chapter; if (!started) play().then(() => seekTo(chapters[i].t)); else seekTo(chapters[i].t); stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); }));

boot().then(() => { requestAnimationFrame(frame); window.demo = { eng, seekTo, chapters, get tl() { return tl; } }; }).catch((e) => { console.error(e); status('error: ' + e.message); });
