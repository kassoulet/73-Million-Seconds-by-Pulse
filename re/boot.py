#!/usr/bin/env python3
"""Boot the original 73MS.EXE image (UPX-unpacked, relocated at 0x1000000) inside Unicorn up to the point where it would
initialise the video mode, then save a snapshot (state.bin) so tools can call individual engine functions quickly.
usage: python3 boot.py        (~2 minutes)"""
import emucore as E
E.at(0x7318,lambda:(print('VIDINIT',E.ireg('EAX'),E.ireg('EDX'),E.ireg('EBX')),E.mu.emu_stop()))   # stop where the original would init video
E.run(E.B+0x7784)
E.save_snapshot(E.HERE+'/state.bin'); print('snapshot saved')
