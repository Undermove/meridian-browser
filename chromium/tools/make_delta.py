#!/usr/bin/env python3
"""An update as the difference between two Meridian.app builds.

  tools/make_delta.py <old Meridian.app> <new Meridian.app> <out .delta>

The .delta is a zip (stored) with manifest.json and files/<n>.zst, read by
chrome/browser/meridian/update_delta.cc: every folder, link and file of the new
app; a file is "same" (taken from the old app as it is), "patch" (zstd with the
old file as its prefix, as `zstd --patch-from`) or "data" (zstd). Each file
names the old file it comes from and that file's SHA-256, and its own SHA-256.

A file is matched to the old app by its path, or by its path with Chromium's
version folder (…/Versions/<version>/…) taken out, so a Chromium update still
patches the framework. Needs the zstd command line tool.
"""

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

# update_delta.cc reads a window of at most 2^30 bytes.
LONG = 30
# The zstd tool: on the PATH, else where Homebrew puts it (the tests take
# /usr/local/bin off their PATH when the person's own AI CLIs are there).
ZSTD = shutil.which('zstd') or next(
    (z for z in ('/opt/homebrew/bin/zstd', '/usr/local/bin/zstd')
     if os.access(z, os.X_OK)), 'zstd')


def sha256(path):
  h = hashlib.sha256()
  with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1 << 20), b''):
      h.update(chunk)
  return h.hexdigest()


def walk(root):
  """(relative path, kind) for every entry, parents first."""
  out = []
  for d, dirs, files in os.walk(root, followlinks=False):
    dirs.sort()
    rel_dir = os.path.relpath(d, root)
    for name in dirs + sorted(files):
      p = os.path.join(d, name)
      rel = name if rel_dir == '.' else os.path.join(rel_dir, name)
      if os.path.islink(p):
        out.append((rel, 'link'))
      elif os.path.isdir(p):
        out.append((rel, 'dir'))
      elif os.path.isfile(p):
        out.append((rel, 'file'))
  return out


def unversioned(rel):
  return re.sub(r'/Versions/\d+(\.\d+)+/', '/Versions/*/', rel)


def main(old, new, out):
  old_files = {rel for rel, kind in walk(old) if kind == 'file'}
  by_unversioned = {unversioned(rel): rel for rel in old_files}
  entries = []
  blobs = []
  stats = {'same': 0, 'patch': 0, 'data': 0}
  with tempfile.TemporaryDirectory() as tmp:
    for rel, kind in walk(new):
      p = os.path.join(new, rel)
      if kind == 'dir':
        entries.append({'path': rel, 'type': 'dir',
                        'mode': stat.S_IMODE(os.lstat(p).st_mode)})
        continue
      if kind == 'link':
        entries.append({'path': rel, 'type': 'link', 'target': os.readlink(p)})
        continue
      entry = {'path': rel, 'type': 'file',
               'mode': stat.S_IMODE(os.stat(p).st_mode), 'sha256': sha256(p)}
      source = rel if rel in old_files else by_unversioned.get(unversioned(rel))
      size = os.path.getsize(p)
      if source:
        old_sha = sha256(os.path.join(old, source))
        entry.update({'from': source, 'from_sha256': old_sha})
        if old_sha == entry['sha256']:
          entry['source'] = 'same'
          entries.append(entry)
          stats['same'] += size
          continue
      blob = os.path.join(tmp, f'{len(blobs)}.zst')
      args = [ZSTD, '-q', '-f', '-19', f'--long={LONG}']
      if source:
        args += ['--patch-from', os.path.join(old, source)]
        entry['source'] = 'patch'
      else:
        entry['source'] = 'data'
      subprocess.run(args + [p, '-o', blob], check=True)
      entry['blob'] = f'files/{len(blobs)}.zst'
      blobs.append(blob)
      stats[entry['source']] += size
      entries.append(entry)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
      z.writestr('manifest.json', json.dumps({'format': 1, 'entries': entries}))
      for i, blob in enumerate(blobs):
        z.write(blob, f'files/{i}.zst')
  mb = lambda b: f'{b / 1e6:.1f} MB'
  print(f'{out}: {mb(os.path.getsize(out))} (same {mb(stats["same"])}, '
        f'patched {mb(stats["patch"])}, new {mb(stats["data"])})')


if __name__ == '__main__':
  if len(sys.argv) != 4:
    sys.exit(__doc__)
  main(*sys.argv[1:])
