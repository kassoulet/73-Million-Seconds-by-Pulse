import os
import struct,sys,collections
from unicorn import *
from unicorn.x86_const import *
from capstone import *
R=lambda n:getattr(sys.modules['unicorn.x86_const'],'UC_X86_REG_'+n)
HERE=os.path.dirname(os.path.abspath(__file__))
img=open(HERE+'/relB.bin','rb').read()
B=0x1000000
SEC=open(HERE+'/../73MIL.SEC','rb').read()
mu=Uc(UC_ARCH_X86,UC_MODE_32)
MEMTOP=0x1b0000
mu.mem_map(0,0x10000000)
mu.mem_write(B,img)

GDT=0x30000000
mu.mem_map(0x30000000,0x100000)
# gdt: 0x08 code, rest flat data
def desc(code,acc=None): return struct.pack('<HHBBBB',0xffff,0,0,acc or (0x9b if code else 0x93),0xcf,0)
g=b''.join(desc(i==1) for i in range(256))
mu.mem_write(GDT,g)
mu.reg_write(UC_X86_REG_GDTR,(0,GDT,len(g)-1,0))
LDT=0x30010000
mu.mem_write(LDT,b''.join(desc(False,0xf3) for i in range(256)))
mu.reg_write(UC_X86_REG_LDTR,(0x30,LDT,255*8+7,0x82))
mu.reg_write(UC_X86_REG_CR0,mu.reg_read(UC_X86_REG_CR0)|1)
for r,s in [('CS',0x08),('DS',0x10),('ES',0x10),('SS',0x10),('FS',0x10),('GS',0x10)]:
    mu.reg_write(R(r),s)
mu.reg_write(UC_X86_REG_ESP,B+0x1af6e0)
md=Cs(CS_ARCH_X86,CS_MODE_32)

def ireg(n): return mu.reg_read(R(n))
PSP=0x30020000
mu.mem_write(PSP+0x80,b'\x00\x0d')
def setdesc(idx,base,limit=0xfffff):
    pass
def setdesc(idx,base,limit=0xfffff):
    mu.mem_write(LDT+idx*8,struct.pack('<HHBBBB',limit&0xffff,base&0xffff,(base>>16)&0xff,0xf3,0xc0|(limit>>16),(base>>24)&0xff))
setdesc(4,PSP)   # 0x24 (ldt idx4)
files={}
for _i in range(1,9): files[_i]=[SEC,0]
nextfd=[5]
def hostfile(name):
    n=name.lower()
    if n.endswith('73mil.sec'): return SEC
    return None
def cstr(a):
    b=b''
    while True:
        c=bytes(mu.mem_read(a,1))
        if c==b'\0': return b.decode('latin1')
        b+=c; a+=1
def setcf(v):
    f=ireg('EFLAGS'); mu.reg_write(UC_X86_REG_EFLAGS,(f|1) if v else (f&~1))

ARENA=0x20000000
mu.mem_map(ARENA,0x10000000)
arena_ptr=[ARENA]
def aalloc(n):
    a=arena_ptr[0]; arena_ptr[0]+=(n+0xfff)&~0xfff; return a
nextsel=[0x40]
dosptr=[0x20000]
VBEMODES={0x101:(640,480,8),0x103:(800,600,8),0x10e:(320,200,16),0x10f:(320,200,24),0x110:(640,480,15),0x111:(640,480,16),0x112:(640,480,24),0x113:(800,600,15),0x114:(800,600,16),0x115:(800,600,24),0x120:(320,200,8),0x121:(320,240,8),0x122:(320,200,32),0x123:(640,480,32)}
curmode=[0]; modes_asked=[]
LFB=0xE0000000
def w(r,v): mu.reg_write(R(r),v&0xffffffff)
def wax(v): w('EAX',(ireg('EAX')&0xffff0000)|(v&0xffff))
def rstruct():
    a=ireg('EDI'); return a,list(struct.unpack('<8I',bytes(mu.mem_read(a,32))))
vbe_handler=[lambda no,a,st:(print("RMINT",hex(no),[hex(x) for x in st]) or False)]
def dpmi(uc):
    ax=ireg('EAX')&0xffff
    bx=ireg('EBX')&0xffff; cx=ireg('ECX')&0xffff; dx=ireg('EDX')&0xffff
    setcf(0)
    if ax==0x0000:
        n=cx; wax((nextsel[0]<<3)|7); nextsel[0]+=n; return True
    if ax==0x0006: w('ECX',0); w('EDX',0); return True
    if ax==0x0007: setdesc(bx>>3,(cx<<16)|dx); return True
    if ax in(0x0008,0x0009,0x000b,0x0003): return True
    if ax==0x000a: wax((nextsel[0]<<3)|7); nextsel[0]+=1; return True
    if ax==0x0100:
        a=dosptr[0]; dosptr[0]+=bx*16; wax(a>>4); w('EDX',(nextsel[0]<<3)|7); setdesc(nextsel[0],a); nextsel[0]+=1; return True
    if ax==0x0101: return True
    if ax in(0x0200,0x0204): w('ECX',0); w('EDX',0); return True
    if ax in(0x0201,0x0205,0x0600,0x0601,0x0602,0x0603): return True
    if ax==0x0400: wax(0x0090); w('EBX',3); w('ECX',4); w('EDX',0x0870); return True
    if ax==0x0500:
        a=ireg('EDI'); mu.mem_write(a,struct.pack('<12I',0x4000000,0x4000,0x4000,0x4000,0x8000,0x4000,0x4000,0x8000,0x1000,0,0,0)); return True
    if ax==0x0501:
        n=(bx<<16)|cx; a=aalloc(n); w('EBX',a>>16); w('ECX',a&0xffff); w('ESI',0); w('EDI',a&0xffff|1); return True
    if ax in(0x0502,): return True
    if ax==0x0800:
        n=(ireg('ESI')<<16 if False else 0)
        sz=((ireg('ESI')&0xffff)<<16)|(ireg('EDI')&0xffff); a=aalloc(max(sz,0x400000)); print('PHYMAP',hex((bx<<16)|cx),hex(sz),'->',hex(a)); phys[0]=a; w('EBX',a>>16); w('ECX',a&0xffff); return True
    if ax==0x0300:
        a,st=rstruct(); no=bx&0xff
        return vbe_handler[0](no,a,st)
    return False
phys=[0]

def lin(seg,off): return (seg<<4)+off
def vbe(no,a,st):
    if no!=0x10: print('RMINT',hex(no),[hex(x) for x in st]); return False
    eax=st[7]; ax=eax&0xffff
    es=struct.unpack('<H',bytes(mu.mem_read(a+0x22,2)))[0]
    di=st[0]&0xffff
    def ret(v):
        st[7]=(eax&0xffff0000)|v
        mu.mem_write(a,struct.pack('<8I',*st))
    if ax==0x4f00:
        p=lin(es,di)
        blk=bytearray(512); blk[0:4]=b'VESA'; struct.pack_into('<H',blk,4,0x0200)
        struct.pack_into('<I',blk,6,(es<<16)|(di+0x100)); struct.pack_into('<I',blk,10,1)
        ml=sorted(VBEMODES)
        struct.pack_into('<I',blk,14,(es<<16)|(di+0x120))
        struct.pack_into('<H',blk,18,64*16)
        for i,m in enumerate(ml): struct.pack_into('<H',blk,0x120+2*i,m)
        struct.pack_into('<H',blk,0x120+2*len(ml),0xffff)
        blk[0x100:0x108]=b'pyvbe\0\0'
        mu.mem_write(p,bytes(blk)); ret(0x4f); print('VBE info',hex(es),hex(di),hex(p)); return True
    if ax==0x4f01:
        m=st[6]&0xffff; p=lin(es,di)
        modes_asked.append(m)
        if m not in VBEMODES: ret(0x14f); return True
        w_,h_,bpp=VBEMODES[m]
        blk=bytearray(256)
        struct.pack_into('<H',blk,0,0x9b); blk[2]=7; blk[3]=7
        struct.pack_into('<HHHH',blk,4,64,64,0xa000,0)
        struct.pack_into('<H',blk,0x10,w_*((bpp+7)//8))
        struct.pack_into('<HH',blk,0x12,w_,h_)
        blk[0x16]=8;blk[0x17]=16;blk[0x18]=1;blk[0x19]=bpp;blk[0x1a]=1;blk[0x1b]=6 if bpp>8 else 4;blk[0x1c]=1
        if bpp==16: blk[0x1f:0x27]=bytes([5,11,6,5,5,0,0,0])
        elif bpp==15: blk[0x1f:0x27]=bytes([5,10,5,5,5,0,0,0])
        elif bpp in(24,32): blk[0x1f:0x27]=bytes([8,16,8,8,8,0,0,0])
        struct.pack_into('<I',blk,0x28,LFB)
        mu.mem_write(p,bytes(blk)); ret(0x4f); print('VBE modeinfo',hex(m),w_,h_,bpp,[hex(x) for x in st],hex(es),hex(p)); return True
    if ax==0x4f02:
        bx=st[4]&0xffff; curmode[0]=bx&0x1ff; print('VBE setmode',hex(bx)); ret(0x4f); return True
    if ax in(0x4f05,0x4f07,0x4f09,0x4f06,0x4f08,0x4f0a): ret(0x4f); return True
    if ax==0x4f03: st[4]=curmode[0]; ret(0x4f); return True
    print('VBE?',hex(ax)); return False
vbe_handler[0]=vbe
cnt=collections.Counter()
keyq=[];polls=[0];sent=[0]
tick=[0]
clk=[0]
def intr(uc,no,_):
    eax=ireg('EAX'); ah=(eax>>8)&0xff; al=eax&0xff
    cnt[(no,ah if no!=0x31 else eax&0xffff)]+=1
    if no==0x21:
        if ah==0x30: mu.reg_write(UC_X86_REG_EAX,0x0005); return
        if ah==0xff: mu.reg_write(UC_X86_REG_EAX,0); return
        if ah==0x4a: setcf(0); return
        if ah==0xed: print('ED',hex(eax),hex(ireg('EBX')),hex(ireg('ECX')),hex(ireg('EDX'))); mu.reg_write(UC_X86_REG_EAX,0); return
        if ah==0x2c:
            clk[0]+=1; t=clk[0]//10  # centiseconds
            cs=t%100; sec=(t//100)%60; mn=(t//6000)%60
            mu.reg_write(UC_X86_REG_ECX,(10<<8)|mn); mu.reg_write(UC_X86_REG_EDX,(sec<<8)|cs); return
        if ah==0x35: mu.reg_write(UC_X86_REG_EBX,0); return
        if ah==0x25: return
        if ah==0x0b: wax(0); return
        if ah==0x44: mu.reg_write(UC_X86_REG_EDX,0x80); setcf(0); return
        if ah==0x3d:
            n=cstr(ireg('EDX')); f=hostfile(n); 
            if f is None: mu.reg_write(UC_X86_REG_EAX,2); setcf(1); return
            fd=nextfd[0]; nextfd[0]+=1; files[fd]=[f,0]; mu.reg_write(UC_X86_REG_EAX,fd); setcf(0); return
        if ah==0x3e: files.pop(ireg('EBX'),None); setcf(0); return
        if ah==0x3f:
            f=files.setdefault(ireg('EBX'),[SEC,0]); n=ireg('ECX'); b=f[0][f[1]:f[1]+n]; mu.mem_write(ireg('EDX'),b); f[1]+=len(b); mu.reg_write(UC_X86_REG_EAX,len(b)); setcf(0); return
        if ah==0x42:
            f=files.setdefault(ireg('EBX'),[SEC,0]); o=struct.unpack('<i',struct.pack('<I',(ireg('ECX')<<16|ireg('EDX'))&0xffffffff))[0]
            f[1]=o if al==0 else f[1]+o if al==1 else len(f[0])+o
            mu.reg_write(UC_X86_REG_EAX,f[1]&0xffff); mu.reg_write(UC_X86_REG_EDX,f[1]>>16); setcf(0); return
        if ah==0x40:
            h=ireg('EBX'); n=ireg('ECX'); b=bytes(mu.mem_read(ireg('EDX'),n))
            if h in(1,2): sys.stdout.write(b.decode('latin1'))
            mu.reg_write(UC_X86_REG_EAX,n); setcf(0); return
        if ah==0x4c: print('EXIT',al); uc.emu_stop(); return
        if ah==0x09:
            print('PRINT',cstr(ireg('EDX')).split('$')[0]); return
    if no==0x10:
        if ah==0: print('SETMODE',hex(al)); return
        if ah==0x0e: sys.stdout.write(chr(al)); return
        if ah in(1,2,5,6,7,9,0x0a,0x0b,0x0c,0x10,0x11): return
        if ah==0x0f: wax(0x5003); return
        if ah==3: w('ECX',0x0607); w('EDX',0); return
    if no==0x16:
        tick[0]+=1; mu.mem_write(0x46c,struct.pack('<I',tick[0]//4))
        cnt[('key',ah)]+=1
        polls[0]+=1
        if polls[0]%3000==0 and len(keyq)==0 and sent[0]<2: keyq.extend([0x1c0d,0x1c0d]); sent[0]+=2
        if ah in(0,0x10):
            if keyq: wax(keyq.pop(0))
            else: wax(0)
            return
        if ah in(1,0x11):
            f=ireg('EFLAGS'); mu.reg_write(UC_X86_REG_EFLAGS,(f&~0x40) if keyq else (f|0x40))
            if keyq: wax(keyq[0])
            return
    if no==0x2f and eax&0xffff==0x1686: wax(0); return
    if no==0x31 and dpmi(uc): return
    print(f"UNHANDLED INT {no:02x} ax={eax&0xffff:04x} ebx={ireg('EBX'):x} ecx={ireg('ECX'):x} edx={ireg('EDX'):x} eip={ireg('EIP'):x}")
    uc.emu_stop()
mu.hook_add(UC_HOOK_INTR,intr)
def mem_inv(uc,access,addr,size,val,_):
    print('MEMFAULT',access,hex(addr),size,'eip',hex(ireg('EIP'))); return False
mu.hook_add(UC_HOOK_MEM_UNMAPPED,mem_inv)

def at(addr,fn):
    mu.hook_add(UC_HOOK_CODE,lambda uc,a,sz,_:fn(),begin=B+addr,end=B+addr)
def run(start,n=600000000):
    try: mu.emu_start(start,0,count=n)
    except Exception as e: print('ERR',e,hex(ireg('EIP')))

HEAPEND=0x22e0000
def save_snapshot(path):
    import zlib,pickle
    regs={n:ireg(n) for n in 'EAX EBX ECX EDX ESI EDI EBP ESP EIP EFLAGS'.split()}
    mem={'low':bytes(mu.mem_read(0,0x100000)),'img':bytes(mu.mem_read(B,HEAPEND)),
         'arena':bytes(mu.mem_read(ARENA,arena_ptr[0]-ARENA)),'desc':bytes(mu.mem_read(GDT,0x20000))}
    st={'regs':regs,'arena_ptr':arena_ptr[0],'nextsel':nextsel[0],'dosptr':dosptr[0]}
    open(path,'wb').write(zlib.compress(pickle.dumps((st,mem)),3))
def load_snapshot(path):
    import zlib,pickle
    st,mem=pickle.loads(zlib.decompress(open(path,'rb').read()))
    mu.mem_write(0,mem['low']); mu.mem_write(B,mem['img']); mu.mem_write(ARENA,mem['arena']); mu.mem_write(GDT,mem['desc'])
    arena_ptr[0]=st['arena_ptr']; nextsel[0]=st['nextsel']; dosptr[0]=st['dosptr']
    for k,v in st['regs'].items():
        if k not in('EIP','EFLAGS'): w(k,v)
    mu.reg_write(UC_X86_REG_FPCW,0x37f)   # snapshot does not hold FPU state: unicorn left FPCW=0 (24-bit precision, breaks the 3D rasteriser's 2^36 magic-number float->fixed trick)
    return st

# ---- calling convention helper (Watcom register call: eax,edx,ebx,ecx) ----
RET=B+0x7a4d
def call(fn,eax=0,edx=0,ebx=0,ecx=0,esp=None,n=2000000000,stack=()):
    """call function at *file* address fn (e.g. 0x2faf8) with Watcom regs; extra stack args pushed right-to-left from `stack`."""
    esp=esp or B+0x1ae000
    for v in reversed(stack): esp-=4; mu.mem_write(esp,struct.pack('<I',v&0xffffffff))
    esp-=4; mu.mem_write(esp,struct.pack('<I',RET))
    for r,v in (('EAX',eax),('EDX',edx),('EBX',ebx),('ECX',ecx),('ESP',esp),('ESI',0),('EDI',0),('EBP',0)): w(r,v)
    mu.emu_start(B+fn,RET,count=n)
    return ireg('EAX')
