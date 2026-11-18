# 73 million seconds (pULSe, 1998) - asm snippets worth reading

All addresses are file addresses of the unpacked, relocated image `re/rel0.bin` (base 0, so address == file offset; `73MS.EXE` is Watcom C/C++32 under DOS/4GW, UPX-packed, unpacked by
the project's Unicorn tooling). Every listing below was re-generated with `python3 -I re/ds.py ADDR N` (capstone) and compared with the listings in `docs/notes/*.html`; they match.
Watcom register convention: arguments in EAX, EDX, EBX, ECX, then the stack.

Two things to know when reading the dumps:

* **Patched operands are placeholders in the file image.** Where the code is self-modifying, the on-disk immediates (`0x270f`, `0x4d2`, `0xbc614e`, `0x1869f`, `0x98967f`...) are filler
  values of the assembler source; the real value is written at run time (the writers are shown).
* The code is the "hand-written core" of a C engine: the demo is 1998 and targets a Pentium MMX class machine, but only the blend/blur primitives use MMX (and they test CPUID first, with an
  integer fallback at 0xb36fc for blend). Everything else is plain x86 + x87.

The recurring themes: self-modifying loops to free registers, carry-chain tricks (`adc`, `sbb`), table lookups instead of multiplies, and the "add 1.5*2^36" float-to-fixed trick.

---

## 1. Self-modifying inner loops, everywhere

The same pattern appears in at least six unrelated routines (fade, echo, matrix, playrgbani, parasite, flare/sprite blitters, reebok): a short set-up routine stores per-call constants into the
operand fields of the loop's own instructions, so the loop needs no register and no memory operand for them.

**fade, the setup (0x51ee0)** selects a row of the alpha table and pokes its address into three loads:

```
51ee0  shl ebx, 8
51ee3  add eax, ebx             ; row a of the colour table
51ee5  add edx, ebx             ; row a of the pixel table
51ee7  mov dword ptr [0x51f4a], edx   ; patch: table base, byte 2
51eed  mov dword ptr [0x51f5b], edx   ;                    byte 1
51ef3  mov dword ptr [0x51f64], edx   ;                    byte 0
```

and the loop (0x51f48, one pixel per iteration, `ebp+esi` = source with `esi` counting up to 0, `edi+esi` = destination):

```
51f48  mov al, byte ptr [edx + 0x270f]   ; imm32 patched: pixel byte 2 -> (v*(256-a))>>8
51f4e  mov bl, byte ptr [ebp + esi + 1]
51f52  shl eax, 0x10
51f55  mov cl, byte ptr [ebp + esi]
51f59  mov ah, byte ptr [ebx + 0x270f]   ; byte 1
51f5f  add esi, 4
51f62  mov al, byte ptr [ecx + 0x270f]   ; byte 0
51f69  add eax, 0x121212                 ; imm32 patched: packed colour*a>>8, added to all 3 bytes at once
51f6e  mov dl, byte ptr [ebp + esi + 2]   ; next pixel's byte 2 loaded early
51f72  mov dword ptr [edi + esi - 4], eax
51f76  test esi, esi
51f78  mov eax, 0
51f7d  jne 0x51f48
```

Why it is nice: a blend with a constant colour costs 3 loads + 3 table lookups + **one** `add eax, imm` for the colour of all three channels, because the table already holds `v*(256-a)>>8` and the colour
contribution `c*a>>8` per channel was packed once into the immediate. The three index registers, the table row and the colour are all free; the pixel loop is software-pipelined (`mov dl,[ebp+esi+2]` is the *next* iteration's load).

**echo, the setup (0xb3640)** patches **six** fields of the loop for a 320x200 effect:

```
b3640  mov dword ptr [0xb3633], esi    ; operand inside the loop
b3646  mov dword ptr [0xb36e1], edi    ; displacement of the store at 0xb36df
b364c  mov dword ptr [0xb36d9], ebx    ; displacement of the picture read at 0xb36d7
b3652  mov dword ptr [0xb36e7], eax    ; displacement of the second store
b3657  mov dword ptr [0xb36c1], edx    ; operand of the warp-table read
b365d  mov dword ptr [0xb3637], ecx    ; time offset into the picture
```

The loop (0xb3693) then needs only two live registers, `edi` (pixel index) and `ebp` (counter):

```
b3693  mov esi, dword ptr [ebp*4 + 0xb2cb3]   ; x zoom table - it lives INSIDE the code segment
b369a  xor ebx, ebx
b369c  add esi, ecx                           ; + row base
b369e  mov al, byte ptr [esi]
b36a0  mov bl, byte ptr [esi + 0x141]         ; 2x2 box: p[321]
b36a6  add eax, ebx
b36a8  mov bl, byte ptr [esi + 0x140]         ; p[320]
b36ae  add eax, ebx
b36b0  mov bl, byte ptr [esi + 1]             ; p[1]
b36b3  add eax, ebx
b36b5  shr eax, 2
b36b8  mov al, byte ptr [eax + 0xb28b3]       ; attenuation table, also copied into the code segment
b36be  mov ebx, dword ptr [edi + edi + 1]     ; warp table entry (16 bit index into the 256x256 picture)
b36c5  and ebx, 0xffff
b36cb  add ebx, dword ptr [0xb3637]            ; + patched time offset
b36d1  and ebx, 0xffff                        ; wrap inside the picture
b36d7  add al, byte ptr [ebx + 1]             ; add the picture pixel ...
b36dd  jb  0xb36f5                            ; ... saturate on carry
b36df  mov byte ptr [edi + 1], al             ; write to the screen buffer
b36e5  mov byte ptr [edi + 1], al             ; ... and to the echo buffer for the next frame
b36eb  inc edi / dec ebp / jne 0xb3693
```

Zoom tables and attenuation table are copied into the code region itself by the routine at 0xb34e3 (the address `0xb2cb3` and `0xb28b3` are in the code area), turning the code segment into a constant pool next to the code that reads it. The two stores at
b36df / b36e5 have different patched displacements: one write goes to the visible buffer, one to the feedback buffer (ping-pong).

**Other patched loops** use the exact same idea with a different payload: the flare/sprite blitters (section 2) patch the texture pointer, a table row and the u-step; parasite (section 3) patches the integer and fractional parts of its 16.16 step into an `adc` and an `add`; `matrix` (0x5276a) patches nine
256-byte table addresses *and* the `out - in` distance into a `mov [esi + imm32], dl` so the store needs no output pointer (`52826  mov [esi + 0x34083], dl`).

## 2. Texture coordinates that live in `cl`/`ch` or `bl`/`bh`, with `adc` carrying the fraction

The sprite and rotozoom blitters keep 8.16 texture coordinates split across registers so that the integer part **is** the 8 bit coordinate and wraps at 256 for free.

Flare / sprite blitter, inner loop (0x59968; `ch:cl` = texture row:column, `esi` = 16 bit fraction of u in the top half):

```
59968  mov al, byte ptr [ecx + 0x1869f]   ; texel = texture[ch*256 + cl]   (imm = texture base, patched at 0x5996a)
5996e  add esi, 0xbc614e                  ; u fraction += du_frac<<16       (patched at 0x59970)
59974  adc cl, 0xc                        ; u integer += du_int + carry     (patched at 0x59976)
59977  mov bl, byte ptr [edi]             ; destination pixel
59979  add bl, byte ptr [eax + 0x98967f]  ; += table[intensity*256 + texel]  (patched at 0x5997b)
5997f  inc edi
59980  sbb dl, dl                         ; carry -> 0xff / 0x00
59983  or  bl, dl                         ; saturate to 255
59985  dec ebp
59986  mov byte ptr [edi - 1], bl
59989  jne 0x59968
```

Nine instructions plus the loop, no multiply, no shift, no mask, 8 bit wrap-around of the texture for free, and the intensity of the particle is a *table row* so a fade-out costs nothing per pixel.

The rotozoom (`reebok`, 0x59304) goes further: the 64 KB texture is copied to a 64 KB aligned block, so `ebx` itself is the texture address and `bl`/`bh` are u/v. Both coordinates advance with carry chains in the same loop:

```
59304  mov al, byte ptr [ebx]             ; texel at (v<<8|u)
59306  mov dl, byte ptr [0xc897a]         ; integer part of du
5930c  add esi, ecx                       ; u fraction += du fraction
5930e  mov dh, byte ptr [0xc897e]         ; integer part of dv
59314  adc bl, dl                         ; u integer += du_int + carry
59316  mov al, byte ptr [eax + 0x117ddc]  ; brightness table of this layer
5931c  mov cl, byte ptr [edi]
5931e  add ebp, edx                       ; v fraction += dv fraction
59320  adc bh, dh                         ; v integer += dv_int + carry
59322  add al, cl                         ; add + saturate:
59324  sbb cl, cl
59327  or  cl, al
```

Two 16.16 DDA accumulators and a 256x256 wrapping texture addressed with zero address arithmetic. A curiosity the port had to reproduce: `ecx`/`edx` still carry the destination pixel and the integer step bytes in their low bytes, and they get added into the fraction accumulators too; the output is bit-exact only with this "bug".

## 3. Parasite: a Bresenham line as a texture walker

The span filler of `parasite` (0x59224) is 7 instructions per pixel, with the fixed-point step of a **per-band** `255/width` patched into the loop:

```
591ea  sar eax, 0xb                  ; level = |s|*32  (>> 11 of the 16.16 value)
59200  sar esi, 0x10                 ; integer part of the step
59204  shl ebp, 0x10                 ; fraction of the step in the upper 16 bits
59207  mov dword ptr [0x59226], esi  ; patch: operand of the adc
59210  mov dword ptr [0x59232], ebp  ; patch: operand of the add
...
59224  adc ebx, 0x4d2                ; ebx += step_int + carry     (imm at 0x59226)
5922a  mov ebp, dword ptr [edx + eax*4]   ; colour = table[level][texel]
5922d  mov dword ptr [edi + ecx*4], ebp   ; store 0x00RRGGBB
59230  add esi, 0xbc614e             ; fraction += step_frac       (imm at 0x59232)
59236  mov al, byte ptr [ebx]        ; next texel
59239  inc ecx
5923a  jne 0x59224
```

The carry out of the fraction add (`add esi,...`) is consumed by the *next iteration's* `adc ebx`, so the texel pointer advances by `int` or `int+1` exactly like a Bresenham line. `ecx` counts from `-count` to 0 and doubles as the index of the destination, so loop control costs one `inc` + `jne`. The 256x256 colour table is
indexed by `level*1024 + texel*4` (`edx` already points at the row) and was built at start-up: palette entry times `cos^3((1-L/256)*pi/2)/64`.

## 4. Saturating adds without branches or MMX: `add / sbb / or`

Everywhere an 8 bit pixel is added to the screen the code uses the same three instructions (seen in echo, flares, radialblur, reebok, echo4's smear):

```
35e65  mov al, byte ptr [edi]               ; echo4 glow smear, 0x35e60 (row pass)
35e67  mov cl, byte ptr [ebx + 0xc472c]     ; T[prev] = round(prev * 0.65)
35e6d  add al, cl
35e6f  inc edi
35e70  sbb cl, cl                           ; CF -> 0xff or 0
35e72  or  al, cl                           ; saturate
35e75  mov bl, al                           ; new pixel becomes 'previous' for its right neighbour
35e77  mov byte ptr [edi - 1], al
```

`sbb cl,cl` turns the carry flag into a mask without a branch, so the loop has no mispredictable jump on a Pentium. In this smear the dependency on the previous output pixel is a **table index** (`bl` is `[ebx+table]`'s index), i.e. the recursive filter `y[i] = x[i] + 0.65*y[i-1]` is one load, one add, one saturation.

**32 bit version, SWAR (volumesprites, 0x5910a).** Three channels are saturated at once with plain integer instructions. The frame-buffer pixel is masked to even bytes, the palette entries have even bytes by construction (the ramp is built with kept even bytes), so a per-channel overflow appears as a carry in bits 8, 16, 24 of the sum, and `carry - (carry>>8)` expands each carry into a 0xff mask:

```
5910a  mov ebx, dword ptr [edi]            ; frame buffer pixel
5910c  mov al, byte ptr [ecx + 0x1869f]    ; texel
59112  and ebx, 0xfefefefe                 ; drop the low bit of every channel
59119  mov eax, dword ptr [eax*4 + 0x1869f]; palette entry
59120  add esi, 0xbc614e                   ; u fraction (patched)
59126  adc cl, 0xc                         ; u integer (patched)
59129  add eax, ebx                        ; channels may overflow into bits 8/16/24
5912b  mov edx, eax
5912d  add edi, 4
59130  and edx, 0x1010100                  ; the three carry bits
59136  mov ebx, edx
59138  shr edx, 8
5913b  sub ebx, edx                        ; 0x100-1, 0x10000-0x100, 0x1000000-0x10000 = 0xff masks
5913d  or  ebx, eax                        ; saturate
59145  mov dword ptr [edi - 4], ebx
```

The cost of the evenness trick is one bit of precision per channel; the gain is a 3-channel saturating add in 7 integer instructions with no MMX state to save and no `emms`. This is the same "add with carry masks" idea that the MMX routine solves with one instruction:

```
b37b0  movq mm0, qword ptr [esi + ecx]
b37b4  paddusb mm0, qword ptr [ebx + ecx]  ; blend mode 1: 8 bytes, unsigned saturating
b37b8  movq qword ptr [edi + ecx], mm0
b37bc  add ecx, 8
b37c2  jne 0xb37b0
```

with a nice detail in the prologue (0xb37a8): `neg ecx; sub esi,ecx; sub ebx,ecx; sub edi,ecx` points all three pointers at the end and counts the index from `-n` up to 0, so the `add ecx, 8` that advances also provides the zero flag for the exit. A SWAR fallback for CPUs without MMX exists (0xb36fc); the engine tests the CPUID bit in `[0xdc2cc]`.

## 5. Radial blur: bilinear interpolation without a multiplication

The radial blur kernel (0x35fec) does three lerps per pixel, each as `a + T[f][b-a]` where the 64x512 byte table `T[f][d] = trunc(d*f/64)` (32 KB, built once at 0x70fc) replaces the multiply:

```
35fec  mov ebp, dword ptr [0xc4718]
35ff2  mov edx, dword ptr [ebp + ecx*4]  ; xtab[x] in 26.6 fixed point
35ff6  mov ebx, edx
35ff8  and ebx, 0x3f                     ; fractional 6 bits
35ffb  shl ebx, 9                        ; * 512 = row of T
3600b  mov al, byte ptr [esi + edx]      ; a = p[0]   (edx = xtab >> 6)
3600e  mov bl, byte ptr [esi + edx + 0x140] ; c = p[+320]
...
3601f  sub edx, ecx                      ; d = c - a  (signed, -255..255)
3602d  add al, byte ptr [ebp + edx]      ; va = a + T[fy][d]    (the table is centred, so negative d indexes below the middle)
...
36080  add dl, byte ptr [ebx + 0xc472c]  ; dest += att[v]
36086  sbb bl, bl
36088  or  dl, bl                        ; saturate
```

The 512-entry rows make the *signed* difference a direct index (the pointer to the table is biased to its middle at `[0xc482c]`), and the final `add al, T[...]` wraps modulo 256 to the right interpolated value. The 8 bit `matrix` convolution (0x5276a) is the same idea with 9 tables of `trunc(v*m_k) & 255` summed with wrapping 8 bit adds.

The effect is also computed **in place**: the four quadrants walk outward from the centre (`dec esi / dec edi` toward the left half), so a pixel reads neighbours already updated in the same pass; one frame of the loop therefore already carries the streaks across the whole screen.

## 6. The float -> fixed trick: add 1.5 * 2^36

Floating-point to 16.16 fixed point in two x87 instructions, without `fistp` and its control-word dance. Parasite's step computation (0x591bd):

```
591bf  fld  st(0)
591c1  fabs
591c3  fadd dword ptr [0xc8964]       ; + 1.5*2^36
591c9  fxch st(1)
591cb  fadd dword ptr [0xc8964]
591d3  fstp qword ptr [0xc8958]       ; store as DOUBLE ...
591d9  fstp qword ptr [0xc8950]
591df  mov  eax, dword ptr [0xc8958]  ; ... and read the LOW dword: the value in 16.16, rounded to nearest-even
591ea  sar  eax, 0xb
```

In a double, the constant `1.5*2^36` leaves the 52 mantissa bits with their lowest 16 integer bits aligned so that the low dword equals `round(x * 65536)`. The edge setup of the sprite blitter (0x58f04, `fadd [0xc88b4]`) and the reebok corner grid use the same trick, and ceil is `add ebx, 0xffff; sar ebx, 16` (0x58f94). The trick **requires the x87 precision control at 53/64 bits**: the first golden frames of the 3D scenes were black because the Unicorn snapshot restored the CPU registers but not the FPU control word (FPCW 0 = 24-bit precision), so the sum was rounded to single precision and every fixed-point value became 0 (fix: `FPCW = 0x37f`, see `re/NOTES.md`).

The other conversion in the engine is the C-cast helper `ftol` at 0x1ed6a, which does the usual Watcom dance (set the rounding bits of the control word with `mov byte [esp+1], 0x1f`, `fldcw`, `frndint`, restore): C-style truncation costs two `fldcw`, hence the engine's choice of the magic-number trick wherever it converts in an inner loop.

```
1ed6c  fnstcw word ptr [esp]
1ed70  push dword ptr [esp]
1ed73  mov byte ptr [esp + 1], 0x1f    ; RC = 11 (toward zero)
1ed78  fldcw word ptr [esp]
1ed7b  frndint
```

## 7. Two texture coordinates in one 32 bit register (echo4/echo6 rasteriser)

The perspective rasteriser (0x8985d) packs U and V as two 8.8 numbers in one `ebx`: U in the high half, V in the low half. One `add ebx, eax` steps both; the two integer parts are extracted with `shr edx, 24` (U) and `mov dh, bh` (V):

```
8a0a7  add ebx, eax            ; step both coordinates
8a0a9  mov edx, ebx
8a0ab  shr edx, 0x18           ; dl = U integer (bits 24..31)
8a0ae  mov dh, bh              ; dh = V integer (bits 8..15)  -> edx = V*256 + U
8a0b0  mov ebp, dword ptr [0xcef10]
8a0b6  mov eax, dword ptr [0xcef14]
8a0bb  mov cl, byte ptr [esi + edx]    ; texel from the 256x256 texture
8a0be  add ebx, eax
8a0c0  add byte ptr [ebp - 7], cl     ; dest += texel (byte wrap)
8a0c3  mov edx, ebx                    ; next pixel, the block is unrolled 8 times ...
```

Three details: the **additive** drawing (`add byte ptr [dest], cl`, a read-modify-write on memory) makes the draw order irrelevant, which removes any need for a depth sort or z-buffer (the engine still buckets triangles into 4096 depth bins but ignores the order); a carry out of V leaks into U, a known quirk reproduced by the port; and the span set-up (0x89fa4) ends in `jmp ecx` into the **unrolled 8-pixel block**, using the jump table at 0xd4570 to enter in the middle, so the remainder of a span has no loop overhead. 1/z is inverted only every 8 pixels, and U/V are linear in between.

## 8. Clip codes with `add` / `adc` and a jump table

Triangle clipping against one plane (0x8a21f) gathers the sign bits of three float values into a 3-bit index, then jumps:

```
8a21f  mov ebp, dword ptr [0xd45d4]    ; x - z of vertex 3 (a float)
8a225  xor eax, eax
8a227  add ebp, ebp                    ; CF = sign bit
8a229  mov ebp, dword ptr [0xd45d0]
8a22f  adc eax, eax                    ; eax = (eax<<1) | CF
8a231  add ebp, ebp
8a233  mov ebp, dword ptr [0xd45cc]
8a239  adc eax, eax
8a23b  add ebp, ebp
8a23d  adc eax, eax
8a23f  mov ebp, dword ptr [eax*4 + 0xd4590]
8a246  jmp ebp                         ; 0 = all outside, 7 = all inside, others: 1 or 2 triangles after clipping
```

The floats are read as integers (`mov ebp,[..]`) and doubled: `add ebp,ebp` shifts the sign bit into CF, `adc eax,eax` shifts it into the case number. No FPU compare, no branches, and the eight cases are handled by eight specialised routines.

## 9. Shadow volumes in two memory operations per span

The beam filler (0x612fc, scene `aziz1`) never stores a pixel; for each span it does:

```
616c4  mov ebx, dword ptr [0xc8c18]    ; row start of this scanline
616ca  sub ecx, edx                    ; span length
616cc  jbe 0x616e1
616ce  cmp ecx, 0x3e8                  ; spans longer than 1000 are dropped
616d4  jg  0x616e1
616d6  lea edi, [ebx + ecx*2]
616d9  add word ptr [ebx + edx*2], ax  ; +k at the left edge
616dd  sub word ptr [edi + edx*2], ax  ; -k just after the last pixel
```

A prefix sum along the row afterwards (the `interpolator` effect) recovers the coverage count: cost per span is two read-modify-writes whatever its length, and counting overlapping shadow-volume faces falls out of the 16 bit wrap-around of the deltas. The `interpolator` loop itself clamps with a single unsigned compare (`cmp eax,0xff; ja store255`, 0x57bad), catching both negative and > 255 values with one branch.

## 10. Fast 1/sqrt from the float bits (marching cubes normals, 0x57d63)

```
57d63  fstp dword ptr [0xc8850]        ; |g|^2 as a float
57d69  mov  eax, dword ptr [0xc8850]
57d6e  mov  ebp, 0xbe000000
57d73  shr  eax, 0x11
57d76  mov  edx, dword ptr [0xc8850]
57d7c  and  eax, 0x7f                  ; top 7 mantissa bits -> table index
57d7f  and  edx, 0x7f800000            ; exponent field
57d85  xor  ebx, ebx
57d87  sub  ebp, edx
57d89  shr  ebp, 1                     ; exponent of 1/sqrt = (0xbe000000 - e) / 2
57d8b  mov  bl, byte ptr [eax + 0xc1a58]  ; mantissa from a 128-byte table built at start-up (0x6258)
57d91  shl  ebx, 0xf
...
57d9e  or   ebp, ebx                   ; assemble the float: r ~ 1/sqrt(|g|^2), ~8 bits
```

followed by one Newton-Raphson step `k = r*0.5*(3 - r*r*|g|^2)` (0x57db1). This is the "integer halving of the exponent + small table" trick, 30 years before it became famous for a different constant. In the same polygoniser, **floats are compared as signed integers** (0x57cd4: `cmp eax, ecx; jl ...`) because the volume values and threshold are positive IEEE numbers, and the 256-case triangle table is selected with two 4-bit masks remembered in a scratch array whose address is patched into the code (0x580e2 `mov dword [esi + 0xfca80], ebp`).

## 11. Smaller things

* **Plasma with 4 mirrored stores (0x584b6).** `plasma1volume` computes `fsin` for one octant only (8x8x8 = 512 sines) and writes every result to four mirrored locations with `fst/fst/fst/fstp` while the destination pointers walk *forwards* in x and *backwards* in the mirror, then `rep movsd` copies slice k to slice 15-k:

  ```
  584b6  fld dword ptr [edi]       ; distance table entry
  584b8  fadd st(3)                ; + Frame*0.02
  584ba  fsin
  584bc  fmul st(2)                ; * b
  584be  fadd st(1)                ; + a
  584c0  fst dword ptr [eax + edx] ; (x,   y)
  584c3  fst dword ptr [eax + esi] ; (15-x, y)
  584c6  fst dword ptr [eax + ebx] ; (x,   15-y)
  584c9  fstp dword ptr [eax + ebp]; (15-x, 15-y)
  ```
  An 8x reduction in transcendental calls, exact because the field is symmetric.

* **Lowpass in MMX, with a one-pixel bug (0xb49ac, 0xb49e3).** Four 16 bit lanes per 32 bit pixel: `psubw / pmullw / psraw 7 / paddw` is `y += (x-y)*a>>7` for all four channels in 4 instructions. The backward pass starts at `esi = 0xb3e38 + 0x500`, one dword too far (it should be `+0x4fc`), reading the first byte past the row; the demo's look depends on it, so the port keeps it:

  ```
  b49ac  movd mm0, dword ptr [esi + ebp]
  b49b6  psubw mm0, mm1
  b49b9  pmullw mm0, mm6
  b49bc  psraw mm0, 7
  b49c0  paddw mm1, mm0
  ...
  b49de  mov esi, 0xb3e38
  b49e3  add esi, 0x500
  ```

* **Inverse-table fades.** Fade/xfade/playrgbani cross-fade all use two 256-byte "multiply by constant" tables rebuilt per frame (`tabA[i] = trunc(i*(1-frac))`, `tabB[i] = trunc(i*frac)`) and one `add` per byte; the table addresses are patched into the loop by 0x4f5d8.

---

## What is not here

I only list what I could confirm in the disassembly or the notes. The engine contains ~25 polygon fillers (0x612fc ... 0x74f88) of which only two are used by the script and neither is MMX; the LightWave/3DS loaders are plain C (Watcom) with jump-table chunk dispatchers and have no remarkable asm; the TCB spline is C-like double-precision x87 code (0x26534/0x242e0) with no particular trick. The LZ/bzip-like decompressors in the archive reader (0x2faf8, 0x2fc39, 0x35d56) were not studied in enough detail for a write-up.
