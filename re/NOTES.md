# Reverse-engineering notes — "73 million seconds" by Pulse (1998)

Everything here was derived from `73MS.EXE` (Watcom C/C++32, DOS/4GW, UPX-packed) and `73MIL.SEC` (archive).
Python with unicorn+capstone+Pillow: `PY=/tmp/claude-1000/-home-gautier-SynologyDrive-code-current-demos-pls73ms/14ca815b-e56e-43c1-bfb1-9c1dbce101f5/scratchpad/t/v/bin/python`
(if it vanished: `python3 -m venv v && v/bin/pip install unicorn capstone pillow`). Run tools from `re/` (`cd re`).

## Files in `re/`
| file | what |
|---|---|
| `rel0.bin` | the UNPACKED + relocated image, base address 0 (so address == file offset). Code `0..0xb6000` (RTL, engine, effects, jpeg/png libs, IMS player), data/strings `0xb6000..0xd7000`. **All data addresses in the code are already `>= 0xb6000`** (relocation applied). Disassembling this file gives real addresses. |
| `relB.bin` | same image relocated for base `B=0x1000000` (what the emulator runs). |
| `ds.py ADDR [N]` | disassemble N instructions at ADDR (hex) from rel0.bin (capstone). |
| `fx.py NAME [which] [N]` | effect lookup: prints descriptor `[init, run, free, 0]` of effect NAME and disassembles function `which` (0 init/parse params, 1 run, 2 free), with symbolic names for common callees. |
| `xref.py ADDR` | file offsets where the 32-bit value ADDR occurs (find code that references a string/global). |
| `strings.txt` | all strings of the data segment with addresses. |
| `assets_raw/` | every file extracted + decompressed from 73MIL.SEC (script.unr, tga, png, xm, lwe/lwv/exp scenes ...). |
| `emucore.py`, `boot.py`, `harness.py`, `state.bin` | Unicorn-based environment: `boot.py` (2 min) runs the original EXE through its init up to the video init and writes `state.bin`; `from harness import *` restores it in 0.2 s and gives `call(fn, eax, edx, ebx, ecx, stack=[...])` (Watcom register convention) so you can call any function of the original with your own buffers. `B = 0x1000000`: real address = `B + file_address`. `HEAP` (= `E.ARENA+0x4000000`) is a free scratch area. |
| `golden.py T0 T1 DT OUTDIR` | **ground truth**: runs the *original* engine headlessly (video init bypassed, music clock replaced by a virtual clock) and saves PNG frames of the SCREEN buffer. `EVERY=n` saves every n-th frame, `COARSE=s` fast-forwards the first part with 0.5 s steps (the script is consumed one command per frame, so always start from t=0 or use COARSE). ~0.2 s wall per frame. **Known problem: the real-time 3D scenes (`scene` effect) currently render black** (see 3D notes), 2D effects are fine. |
| `xm_times.json` | (order,row) -> seconds table of tour2.xm. |

## Container / data
* `73MIL.SEC`: sequence of entries `[u32 usize][u32 csize][u32 namelen][u32 dataofs][u32 nameofs][u32 dataend][u8 type][name\0][data...]`.
  Types: `0` stored, `2` = LZ variant A (function 0x2faf8(src,dst,csize)), `3` = variant B (0x2fc39), `t` = TGA stored as type 2, `j`/`p` = raw JPEG/PNG, `b` = bzip-like block coder (0x35d56, NEBAR.ANI = 40 frames 320x180x24).
  `re/assets_raw` + `docs/assets` contain the results (TGA -> PNG conversion in docs/assets, 8-bit TGAs as `.idx` + `.tgapal`).
* `script.unr` is the whole demo: text lines `[<order> <row>] command ...` (time = XM order/row of `tour2.xm`; lines without time keep the previous one). Commands: createBuffer, loadscene, loadanim, addEvent, deleteEvent, changeBuffers, controlfloat, lwotr, lwoshading, beamson/off, renderoff, TheEnd ...
* **Time**: the engine reads the module position (order,row) and a 16.16 clock from the IMS player; global `frame` (float at `0xbcec8`) = that clock * 100 (= **centiseconds**). An event's `Frame` variable (used in expressions like `1.0-clip10(Frame*0.003)`) = `frame - frame_at_first_run` (state+0x10 in most effects). Expression evaluator functions: SIN COS TAN ASIN ACOS ATAN FABS SQRT SQR FLOOR CEIL CLIP10 CLIP11 CLIP DELTA FRAME. Evaluate with `0x50760(expr_ptr, frame_delta)` (float result on the FPU stack/arg: see fade run at 0x11654); compile with `0x505f8(string)`.
* IMS = "Indoor Music System" (Niklas Beisert / Cubic Team) plays the XM; Sound device `quiet` is used in the emulator.

## Engine structures (addresses are file addresses / data addresses already relocated)
* Effect table: `0xbd2d0`, 20-byte records: `char name[16]; u32 getDescriptor`. `getDescriptor()` returns a pointer to `{init, run, free, 0}`.
  `init(eax = param string)` -> returns state pointer (sscanf + compile expressions), `run(eax = state, edx = event)`, `free(eax = state)`.
* Event object (0x4f bytes, created in script parser at 0x4038): +0 type name, +0x10 instance name, +0x20/0x24/0x28 = init/run/free, +0x2c state, +0x30 -> output buffer descriptor, +0x40 -> (first) input buffer descriptor, +0x44 flags (bit0 = suppressed), +0x48 order, +0x49 row (start time). Events live in 4 layers: arrays of pointers at `0x10bb90 + layer*0x400`, counts at `0xc1bac + layer*4`. Frame function = `0x4e7c` (locks buffers, runs layers 0..3 in order, then scene render passes, then present `0x749d`). Per-frame driver = `0x364`.
* Buffer table: `0x10cd50`, stride 0x28: `char name[16]` (lower-case), `+0x10 w, +0x14 h, +0x18 bpp (8/16/32), +0x1c object ptr, +0x20 data pointer (set at the start of every frame by the lock loop)`. Buffer descriptors passed to effects have the same layout (`[desc+0x10]` width, `[desc+0x14]` height, `[desc+0x18]` bpp, `[desc+0x20]` pixels). 32 bpp = `0x00RRGGBB`, 16 bpp = RGB565, 8 bpp = indices (palette via the `palette` effect which converts 8 -> 32).
* Scenes: table of pointers at `0x10cb90` (up to 64), name at +0x71 (lower-case file name given to `loadscene`), the `scene` effect (init 0xe29e, run 0xe3c7) copies the 0x9e-byte scene record to global `0x10d900` and calls `[scene+4]` = 0x4fa0 (render scene).
* Loaders: archive access `0x6a77(name)` / `0x6b25(name, flag, buf)`; LWO/LWS-like scenes: `loadlws.c`, `loaduexp.c`; `.lwo` names inside `.lwe` probably map to `.lwv` entries of the archive (unverified); `.exp` = `UEXP` scene.
* Helper "inner loop" routines called by the 2D effects (MMX / x86): 0x51d88, 0x51db1, 0x51df8, 0x51e1c, 0x51e53, 0x51ee0, 0x51f28 ... (fade/blend/copy primitives), 0x1ed6a = ftol (float->int round).

## Tips
* `ds.py` output uses Watcom conventions: arguments in eax, edx, ebx, ecx; locals via ebp; the prologue `push N; call 0x2ebfc` is the stack check.
* The engine is plain C compiled with Watcom (-od?), so the code reads like a literal translation of the C; inner loops of the optimised helpers use MMX.
* To verify a JS effect against the original you can (a) call the original `run` with a hand-built event/buffer set in the harness and compare output buffers byte for byte, or (b) compare with `golden.py` frames at a time where the effect is visible.
