import sys,struct
d=open(__import__('os').path.dirname(__import__('os').path.abspath(__file__))+'/rel0.bin','rb').read()
t=int(sys.argv[1],16)
p=struct.pack('<I',t)
i=d.find(p)
while i>=0:
    print(hex(i)); i=d.find(p,i+1)
