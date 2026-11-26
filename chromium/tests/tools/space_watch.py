#!/usr/bin/python3 -I
# Watches what the person at this Mac sees, for space_guard.mjs: one JSON line whenever the active
# Space (CGSGetActiveSpace) or the frontmost app's pid changes, and once at the start; and one line
# for each browser app (Meridian, Arc, Chrome…) that macOS starts (parent launchd) from anywhere but
# the folders given as arguments (the build under test). No window, no Dock icon (it never becomes
# an app). Ends when its stdin closes (the test process went away).
import ctypes, json, os, re, subprocess, sys, threading, time

ALLOWED = [a for a in sys.argv[1:] if a]
BROWSER = re.compile(r'/(Meridian[^/]*|Arc|Google Chrome[^/]*|Chromium|Brave Browser|Microsoft Edge|Vivaldi|Opera)\.app/Contents/MacOS/[^/]+$')

def browsers():
    out = {}
    try:
        ps = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,comm='], capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return out
    for line in ps.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[1] == '1' and BROWSER.search(parts[2]) and not any(parts[2].startswith(a) for a in ALLOWED):
            out[int(parts[0])] = parts[2]
    return out

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
known = browsers()
last = None
tick = 0
while True:
    tick += 1
    if tick % 4 == 0:
        now_browsers = browsers()
        for pid, exe in now_browsers.items():
            if pid not in known:
                print(json.dumps({'t': int(time.time() * 1000), 'alien': {'pid': pid, 'exe': exe}}), flush=True)
        known = now_browsers
    now = (int(cg.CGSGetActiveSpace(conn)), front())
    if now != last:
        print(json.dumps({'t': int(time.time() * 1000), 'space': now[0], 'front': now[1]}), flush=True)
        last = now
    time.sleep(0.15)
