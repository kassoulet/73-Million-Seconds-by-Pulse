import sys
from capstone import *
d=open(__import__('os').path.dirname(__import__('os').path.abspath(__file__))+'/rel0.bin','rb').read()
md=Cs(CS_ARCH_X86,CS_MODE_32)
a=int(sys.argv[1],16); n=int(sys.argv[2],0) if len(sys.argv)>2 else 60
while n>0 and a<len(d):
    got=False
    for i in md.disasm(d[a:a+16],a,1):
        print(f"{i.address:x}\t{i.bytes.hex():<14}{i.mnemonic} {i.op_str}"); a+=i.size; got=True
    if not got: print(f"{a:x}\tdb {d[a]:02x}"); a+=1
    n-=1
