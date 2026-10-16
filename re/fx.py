import struct,sys
from capstone import *
d=open(__import__('os').path.dirname(__import__('os').path.abspath(__file__))+'/rel0.bin','rb').read()
md=Cs(CS_ARCH_X86,CS_MODE_32)
names={}
tab=0xbd2d0
for i in range(100):
    n=d[tab+i*20:tab+i*20+16].split(b'\0')[0]
    if not n or n[0]<32: break
    names[n.decode()]=struct.unpack_from('<I',d,tab+i*20+16)[0]
known={0xef0:'memset',0x2ebfc:'stackchk',0xb1c:'alloc',0xbb8:'free',0x1bf2a:'sscanf',0x5600:'strcmp',0x4f27d:'compile_expr',0x55d1:'puts',0x7ed4:'error'}
def dis(a,end=None,maxn=400):
    n=0
    while n<maxn:
        got=False
        for i in md.disasm(d[a:a+16],a,1):
            ops=i.op_str
            if i.mnemonic=='call':
                try: t=int(ops,16); ops=known.get(t,ops)
                except ValueError: pass
            print(f"{i.address:x}\t{i.mnemonic} {ops}"); a+=i.size; got=True
        if not got: print(f"{a:x}\tdb {d[a]:02x}"); a+=1
        n+=1
        if end and a>=end: break
def fx(name):
    p=names[name]
    desc=struct.unpack_from('<4I',d,struct.unpack_from('<I',d,0)[0]) if False else None
    # run get-descriptor fn: find 'mov [ebp-4], imm' pattern
    code=d[p:p+0x40]
    i=code.find(b'\xc7\x45\xfc')
    ptr=struct.unpack_from('<I',code,i+3)[0]
    return struct.unpack_from('<4I',d,ptr)
if __name__=='__main__':
    nm=sys.argv[1]; f=fx(nm); print(nm,[hex(x) for x in f])
    which=int(sys.argv[2]) if len(sys.argv)>2 else 1
    dis(f[which],maxn=int(sys.argv[3]) if len(sys.argv)>3 else 300)
