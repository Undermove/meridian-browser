# crashes.py <since YYYY-MM-DD-HHMMSS>: Meridian*/Meridian Beta crash reports newer than that, classified.
import json, os, sys
D = os.path.expanduser('~/Library/Logs/DiagnosticReports')
since = sys.argv[1]
for n in sorted(os.listdir(D)):
    if not n.startswith('Meridian') or not n.endswith('.ips'):
        continue
    stamp = n.rsplit('-', 4)[-4:]
    ts = '-'.join(stamp).replace('.ips', '')
    if ts < since:
        continue
    try:
        t = open(os.path.join(D, n)).read().split('\n', 1)
        h = json.loads(t[0]); b = json.loads(t[1])
        th = [x for x in b['threads'] if x.get('triggered')][0]
        syms = [f.get('symbol', '?') for f in th['frames'][:12]]
        kind = 'aperitif-sandbox-init-abort (benign: renderer started while the test closed the browser)' if any('aperitif_mac.cc' in s or 'FatalError' in s for s in syms) else 'OTHER'
        print(f"{n}\t{b.get('procPath','')[-60:]}\t{b.get('exception',{}).get('signal')}\t{kind}")
        if kind == 'OTHER':
            print('   ', ' | '.join(syms[:8]))
    except Exception as e:
        print(n, 'unreadable', e)
