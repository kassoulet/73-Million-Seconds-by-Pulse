"""Run the ORIGINAL demo code (from state.bin) headlessly, driven by a virtual music clock, and dump frames.
usage: python3 golden.py <t_start> <t_end> <step_seconds> <outdir>
Video init is bypassed (7318 -> return 0); the IMS clock functions (d900,d448) are replaced by a mailbox;
the final 'present' (749d) is hooked to capture the surface."""
import sys,json,os,struct
import emucore as E
from emucore import mu,B,ireg,w
from unicorn import *
from unicorn.x86_const import *
st=E.load_snapshot(E.HERE+'/state.bin')
TIMES=json.load(open(E.HERE+'/xm_times.json'))
MAIL=0x70000      # low memory mailbox: [0]=time16.16 [4]=order<<16|row<<8
def patch(addr,b): mu.mem_write(B+addr,bytes(b))
patch(0x7318,[0x31,0xc0,0xc3])                                   # xor eax,eax ; ret  (video init OK)
patch(0xd900,[0xa1]+list(struct.pack('<I',MAIL))+[0xc3])        # mov eax,[MAIL] ; ret
patch(0xd448,[0xa1]+list(struct.pack('<I',MAIL+4))+[0xc3])
patch(0x35fd,[0xeb])                                             # createBuffer: treat first buffer like the others (skip vid init)
patch(0x749d,[0xc3])                                             # present: no-op (captured by hook)
t=[0.0]; dt=[1/30]; frames=[]
BUFMEM=E.ARENA+0xc000000; bufptr={}; nxt=[BUFMEM]
def lock_hook():                       # replaces surface lock (742a): give each buffer object its own pixel memory
    obj=ireg('EAX')
    if obj not in bufptr:
        for i in range(64):
            e=B+0x10cd50+0x28*i
            if struct.unpack('<I',bytes(mu.mem_read(e+0x1c,4)))[0]==obj:
                wd,ht,bp=struct.unpack('<III',bytes(mu.mem_read(e+0x10,12))); bufptr[obj]=nxt[0]; nxt[0]+=(wd*ht*bp//8+0x1000)&~0xfff; break
        else: bufptr[obj]=nxt[0]; nxt[0]+=0x100000
    esp=ireg('ESP'); ret=struct.unpack('<I',bytes(mu.mem_read(esp,4)))[0]
    w('EAX',bufptr[obj]); w('ESP',esp+4); mu.reg_write(UC_X86_REG_EIP,ret)
def row_at(ts):
    o=0
    while o+1<len(TIMES) and TIMES[o+1][0]<=ts: o+=1
    r=0
    while r+1<len(TIMES[o]) and TIMES[o][r+1]<=ts: r+=1
    return o,r
def setclock(ts):
    o,r=row_at(ts)
    mu.mem_write(MAIL,struct.pack('<II',int(ts*65536),(o<<16)|(r<<8)))
COARSE=[None]   # (until_time, step): before `until` the clock advances in big steps (script commands still execute one per frame)
def on_frame_start():
    c=COARSE[0]
    t[0]+= c[1] if (c and t[0]<c[0]) else dt[0]
    setclock(t[0])
def on_present():
    surf=struct.unpack('<I',bytes(mu.mem_read(B+0x10cd6c,4)))[0]; frames.append((t[0],surf)); capture(surf)
captured=[]
def capture(surf):
    d=bytes(mu.mem_read(B+0x10cd50,0x28)); wd,ht,bpp=struct.unpack_from('<III',d,0x10); dp=struct.unpack_from('<I',d,0x20)[0]
    captured.append((t[0],wd,ht,bpp,dp))
    if len(captured)==1: print('PRESENT w,h,bpp,data',wd,ht,bpp,hex(dp))
    if OUT and t[0]>=T0[0] and (len(captured)%EVERY==0):
        save(t[0],wd,ht,bpp,dp)
def save(ts,wd,ht,bpp,dp):
    n=wd*ht*(bpp//8); raw=bytes(mu.mem_read(dp,n))
    from PIL import Image
    if bpp==32: im=Image.frombuffer('RGBA',(wd,ht),raw,'raw','BGRA',0,1).convert('RGB')
    elif bpp==8: im=Image.frombuffer('L',(wd,ht),raw,'raw','L',0,1)
    elif bpp==16:
        px=struct.unpack('<%dH'%(wd*ht),raw); im=Image.new('RGB',(wd,ht)); im.putdata([(((p>>11)&31)*255//31,((p>>5)&63)*255//63,(p&31)*255//31) for p in px])
    im.save('%s/f_%07.3f.png'%(OUT,ts))
T0=[0.0]
OUT=None;EVERY=int(os.environ.get('EVERY','1'))
def at(addr,fn):
    mu.hook_add(UC_HOOK_CODE,lambda uc,a,sz,_:fn(),begin=B+addr,end=B+addr)
at(0x742a,lock_hook)
at(0x364,on_frame_start)
at(0x749d,on_present)
if __name__=='__main__':
    t0=float(sys.argv[1]); t1=float(sys.argv[2]); dt[0]=float(sys.argv[3]); OUT=sys.argv[4]; os.makedirs(OUT,exist_ok=True)
    t[0]=-dt[0]; T0[0]=t0
    if os.environ.get('COARSE'): COARSE[0]=(t0-float(os.environ['COARSE']),0.5)   # e.g. COARSE=4 -> fast-forward to t0-4s
    # resume at video init (function entry, patched to return 0)
    w('ESP',st['regs']['ESP']); 
    def stop_at_end():
        if t[0]>=t1: mu.emu_stop()
    at(0x364,stop_at_end)
    try: mu.emu_start(B+0x7318,0,count=4000000000)
    except Exception as e: print('ERR',e,hex(ireg('EIP')))
    print('frames captured',len(captured),'last t',t[0])
