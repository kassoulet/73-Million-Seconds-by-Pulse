import struct
B=0x1000000
d=bytearray(open('unf.bin','rb').read())
tr=struct.unpack_from('<3I',d,len(d)-12); print([hex(x) for x in tr])
pos=0xd7000; end=len(d)-12
blocks=[]
n=0
while pos<end:
    delta,=struct.unpack_from('<I',d,pos); pos+=4
    if delta>=0xffffff00 or pos>=end: print('end marker',hex(delta),hex(pos)); break
    edi=0; cnt=0
    while True:
        b=d[pos]; pos+=1
        if b==0: break
        if b>0xef:
            b=((b&0xf)<<16)|(d[pos]|(d[pos+1]<<8)); pos+=2
        edi+=b
        v,=struct.unpack_from('<I',d,edi); struct.pack_into('<I',d,edi,(v+delta+B)&0xffffffff); cnt+=1
    blocks.append((hex(delta),cnt)); n+=cnt
print(blocks,n)
open('relB.bin','wb').write(d[:0xd7000])
