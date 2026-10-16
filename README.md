# 73 million seconds (Pulse, 1998) — JavaScript port

* `docs/` — the GitHub Pages site (player + write-up). Enable Pages: *Settings → Pages → Deploy from branch → `/docs`*. Try locally: `cd docs && python3 -m http.server`.
* `docs/js/` — engine (`engine.js`, `core.js`, `xmtime.js`), effects (`fx/`), player (`main.js`). Music: original `tour2.xm` via chiptune3/libopenmpt (`docs/vendor`).
* `re/` — reverse-engineering notes (`NOTES.md`), unpacked image, Unicorn harness, `golden.py` (runs the original engine headlessly for reference frames).
* `tools/` — `render.mjs` (headless render at time t), `mkmanifest.mjs` (run after adding assets/notes), `browser-test.mjs`, `cmp.py`.
* Original files: `73MS.EXE`, `73MIL.SEC`, `73MS.NFO`. Demo and assets © Pulse 1998; this is a non-commercial study.
