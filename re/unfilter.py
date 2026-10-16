import struct
d=bytearray(open('dump.bin','rb').read())
ebp=0x10000
for op in (0xe8,0xe9):
    eax=0x11000000|op
    i=0; n=0
    while i<0xb6000:
        if d[i]==op:
            edi=i+1+ebp
            ebx=struct.unpack_from('<I',d,i+1)[0]
            ebx=(ebx-eax)&0xffffffff
            if ebx<0x800000:
                ebx=(ebx-edi+ebp)&0xffffffff
                struct.pack_into('<I',d,i+1,ebx); n+=1
                i+=5; continue
        i+=1
    print(hex(op),n)
open('unf.bin','wb').write(d)
