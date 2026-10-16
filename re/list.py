import struct
SEC=open('/home/gautier/SynologyDrive/code/current/demos/pls73ms/73MIL.SEC','rb').read()
# walk sequentially: [usize][csize][namelen] then type char, name, then data (csize bytes)
pos=0;ents=[]
while pos<len(SEC):
    us,cs,nl,do,no,de=struct.unpack_from('<6I',SEC,pos)
    typ=chr(SEC[pos+24]); name=SEC[pos+25:pos+25+nl-1].decode('latin1')
    ents.append((name,typ,us,cs,do,de))
    pos=de
    if pos>=len(SEC)-0: break
for e in ents: print(e)
print(len(ents),pos,len(SEC))
