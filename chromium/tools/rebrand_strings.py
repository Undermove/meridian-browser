#!/usr/bin/env python3
"""Renames the product in Chromium's unbranded strings: "Chromium" -> "Meridian".

Translations (.xtb) are keyed by a fingerprint of the English text, so changing the English text
would silently drop every translation. This rewrites the .grd and then re-keys each .xtb entry from
the old fingerprint to the new one, renaming the product inside the translation too.

Run from Chromium's src/. Idempotent.
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.join('tools', 'grit'))
from grit import grd_reader  # noqa: E402
from grit import util  # noqa: E402

GRDS = ['chrome/app/chromium_strings.grd', 'components/components_chromium_strings.grd']
OLD, NEW = 'Chromium', 'Meridian'
# Keep these: they name the open-source project or are technical identifiers, not the product.
KEEP = ['Chromium OS', 'ChromiumOS', 'The Chromium Authors', 'Chromium Authors', 'chromium.org',
        'Chromium project', 'open source project called Chromium']


def message_ids(grd_path):
  root = grd_reader.Parse(grd_path, debug=False, skip_validation_checks=True)
  ids = {}
  for node in root.Preorder():
    if node.name == 'message':
      for clique in node.GetCliques():
        ids[node.attrs['name']] = clique.GetMessage().GetId()
  return ids


def rename(text):
  marks = {}
  for i, k in enumerate(KEEP):
    token = '\x00%d\x00' % i
    marks[token] = k
    text = text.replace(k, token)
  text = re.sub(r'\b%s\b' % OLD, NEW, text)
  for token, k in marks.items():
    text = text.replace(token, k)
  return text


def main():
  for grd in GRDS:
    before = message_ids(grd)
    with open(grd, encoding='utf-8') as f:
      src = f.read()
    # Only message bodies change; attribute values (names, file paths) stay.
    out = re.sub(r'(<message\b[^>]*>)(.*?)(</message>)',
                 lambda m: m.group(1) + rename(m.group(2)) + m.group(3), src, flags=re.S)
    if out == src:
      print('%s: already renamed' % grd)
      continue
    with open(grd, 'w', encoding='utf-8') as f:
      f.write(out)
    after = message_ids(grd)
    remap = {before[n]: after[n] for n in before if n in after and before[n] != after[n]}
    xtb_dir = os.path.join(os.path.dirname(grd), 'resources' if 'chrome/app' in grd else 'strings')
    stem = os.path.splitext(os.path.basename(grd))[0]
    xtbs = glob.glob(os.path.join(xtb_dir, stem + '_*.xtb'))
    for xtb in xtbs:
      with open(xtb, encoding='utf-8') as f:
        data = f.read()

      def fix(m):
        old_id, body = m.group(1), m.group(2)
        return '<translation id="%s">%s</translation>' % (remap.get(old_id, old_id), rename(body))
      data = re.sub(r'<translation id="(\d+)">(.*?)</translation>', fix, data, flags=re.S)
      with open(xtb, 'w', encoding='utf-8') as f:
        f.write(data)
    print('%s: %d messages re-keyed in %d translations' % (grd, len(remap), len(xtbs)))


if __name__ == '__main__':
  main()
