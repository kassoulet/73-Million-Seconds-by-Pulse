"""Fast harness: `from harness import *` loads state.bin (run boot.py once) and exposes
 mu (Unicorn), call(fn, eax, edx, ebx, ecx, stack=[...]), B (image base 0x1000000), rd/wr helpers.
Addresses: code/function addresses are 'file' addresses (as in rel0.bin / ds.py); real address = B + addr.
Data addresses in rel0.bin are >= 0xb6000 already (relocated) - add B too when poking memory."""
import struct
import emucore as E
from emucore import mu,B,call,ireg,w
E.load_snapshot(E.HERE+'/state.bin')
def rd(addr,n): return bytes(mu.mem_read(addr,n))
def wr(addr,b): mu.mem_write(addr,bytes(b))
def rd32(addr): return struct.unpack('<I',rd(addr,4))[0]
def wr32(addr,v): wr(addr,struct.pack('<I',v&0xffffffff))
def rdf(addr): return struct.unpack('<f',rd(addr,4))[0]
def wrf(addr,v): wr(addr,struct.pack('<f',v))
HEAP=E.ARENA+0x4000000   # scratch area you may use for buffers (mapped RW)
