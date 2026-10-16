// Loads every effect module (each registers itself in FX). Missing modules are skipped.
for (const m of ['basic2d', 'feedback', 'scene3d', 'volumes', 'flares']) {
  try { await import('./' + m + '.js'); }
  catch (e) { if (!/Cannot find module|Failed to fetch|Failed to load|404|not found/i.test(String(e && e.message))) console.warn('fx module', m, 'failed:', e); }
}
