#!/usr/bin/python3 -I
# Watches what the person at this Mac sees, for space_guard.mjs. One JSON line:
#   - whenever the active Space (CGSGetActiveSpace) or the frontmost app's pid changes, and once at
#     the start, with `idle`: the seconds since the person's last own input (keyboard, mouse,
#     trackpad gesture; CGEventSourceSecondsSinceLastEventType of the HID system state). A test
#     browser drives itself over the DevTools protocol and never makes HID input, so a Space switch
#     right after the person's own input is the person's doing (a swipe, ⌃→, ⌘⇥, a click in the
#     Dock), and one without input came from an app;
#   - for each window of a test browser that is on the screen and can be seen (alpha above 0):
#     background mode keeps every test window at alpha 0, so this is a window it missed. The test
#     browsers' pids come on stdin, one per line;
#   - for each browser app (Meridian, Arc, Chrome…) that macOS starts (parent launchd) from anywhere
#     but the folders given as arguments (the build under test).
# No window, no Dock icon (it never becomes an app). Ends when its stdin closes (the test process
# went away).
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
        # Only an app itself, not its helpers (…/Contents/Frameworks/…/Helpers/X Helper (Renderer).app):
        # macOS starts a running browser's renderers from launchd too (the owner's Chrome opening a
        # page is not a browser started).
        if len(parts) == 3 and parts[1] == '1' and BROWSER.search(parts[2]) and '/Contents/Frameworks/' not in parts[2] and not any(parts[2].startswith(a) for a in ALLOWED):
            out[int(parts[0])] = parts[2]
    return out

cg = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg.CGSMainConnectionID.restype = ctypes.c_int
cg.CGSGetActiveSpace.restype = ctypes.c_uint64
cg.CGSGetActiveSpace.argtypes = [ctypes.c_int]
cg.CGEventSourceSecondsSinceLastEventType.restype = ctypes.c_double
cg.CGEventSourceSecondsSinceLastEventType.argtypes = [ctypes.c_int32, ctypes.c_uint32]
cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFDictionaryGetValue.restype = ctypes.c_void_p
cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFRelease.argtypes = [ctypes.c_void_p]
conn = cg.CGSMainConnectionID()
HID_STATE, ANY_INPUT = 1, 0xFFFFFFFF
ON_SCREEN_ONLY, EXCLUDE_DESKTOP = 1, 16
K_PID, K_ALPHA, K_LAYER, K_NUMBER = (cf.CFStringCreateWithCString(None, k, 0x08000100) for k in (b'kCGWindowOwnerPID', b'kCGWindowAlpha', b'kCGWindowLayer', b'kCGWindowNumber'))

def number(d, key, kind):  # kind: kCFNumberSInt64Type (4) or kCFNumberDoubleType (13)
    v = cf.CFDictionaryGetValue(d, key)
    if not v:
        return None
    out = ctypes.c_double() if kind == 13 else ctypes.c_int64()
    cf.CFNumberGetValue(v, kind, ctypes.byref(out))
    return out.value

def shown(pids):
    # Windows of `pids` on the screen now that can be seen: (pid, window number).
    if not pids:
        return []
    arr = cg.CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0)
    if not arr:
        return []
    out = []
    try:
        for i in range(cf.CFArrayGetCount(arr)):
            d = cf.CFArrayGetValueAtIndex(arr, i)
            pid = number(d, K_PID, 4)
            if pid in pids and (number(d, K_ALPHA, 13) or 0) > 0.01:
                out.append((int(pid), int(number(d, K_NUMBER, 4) or 0)))
    finally:
        cf.CFRelease(arr)
    return out

def idle():
    return round(cg.CGEventSourceSecondsSinceLastEventType(HID_STATE, ANY_INPUT), 2)

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

test_pids = set()

def read_pids():
    for line in sys.stdin:
        line = line.strip()
        if line.isdigit():
            test_pids.add(int(line))
    os._exit(0)

threading.Thread(target=read_pids, daemon=True).start()
known = browsers()
seen = set()
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
        for pid, wid in shown(set(test_pids)):
            if (pid, wid) not in seen:
                seen.add((pid, wid))
                print(json.dumps({'t': int(time.time() * 1000), 'shown': pid, 'window': wid}), flush=True)
    now = (int(cg.CGSGetActiveSpace(conn)), front())
    if now != last:
        print(json.dumps({'t': int(time.time() * 1000), 'space': now[0], 'front': now[1], 'idle': idle()}), flush=True)
        last = now
    time.sleep(0.15)
