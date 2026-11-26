#!/usr/bin/python3 -I
# Watches what the person at this Mac sees, for space_guard.mjs: one JSON line whenever the active
# Space (CGSGetActiveSpace) or the frontmost app's pid changes, and once at the start. No window, no
# Dock icon (it never becomes an app). Ends when its stdin closes (the test process went away).
import ctypes, json, os, subprocess, sys, threading, time

cg = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cg.CGSMainConnectionID.restype = ctypes.c_int
cg.CGSGetActiveSpace.restype = ctypes.c_uint64
cg.CGSGetActiveSpace.argtypes = [ctypes.c_int]
conn = cg.CGSMainConnectionID()

def front():
    try:
        asn = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=2).stdout.strip()
        out = subprocess.run(['/usr/bin/lsappinfo', 'info', '-only', 'pid', asn], capture_output=True, text=True, timeout=2).stdout
        for part in out.replace('=', ' = ').split():
            if part.isdigit():
                return int(part)
    except Exception:
        pass
    return 0

def gone():
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=gone, daemon=True).start()
last = None
while True:
    now = (int(cg.CGSGetActiveSpace(conn)), front())
    if now != last:
        print(json.dumps({'t': int(time.time() * 1000), 'space': now[0], 'front': now[1]}), flush=True)
        last = now
    time.sleep(0.15)
