#!/usr/bin/env python3
"""Meridian's icon in the sizes and formats Chromium's Linux and Windows builds use.

  chromium/tools/gen_platform_icons.py <icon-1024.png> <chrome/app/theme/chromium>

Writes, over Chromium's own files in the theme folder:
  product_logo_<n>.png, linux/product_logo_<n>.png, win/tiles/*.png   (each at its current size)
  linux/product_logo_32.xpm
  win/chromium.ico                                                    (16 to 256 px)
Only the standard library: the build machines have no image tools in common (macOS has sips,
which generate.sh uses there). The source must be an 8-bit RGBA, non-interlaced PNG.
"""
import glob
import os
import struct
import sys
import zlib


def read_png(path):
  """-> (width, height, rows); each row a bytearray of RGBA bytes."""
  data = open(path, 'rb').read()
  if data[:8] != b'\x89PNG\r\n\x1a\n':
    sys.exit(f'{path}: not a PNG')
  pos, idat, width, height = 8, [], 0, 0
  while pos < len(data):
    length, kind = struct.unpack('>I4s', data[pos:pos + 8])
    body = data[pos + 8:pos + 8 + length]
    pos += 12 + length
    if kind == b'IHDR':
      width, height, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', body)
      if (depth, colour, interlace) != (8, 6, 0):
        sys.exit(f'{path}: need an 8-bit RGBA, non-interlaced PNG')
    elif kind == b'IDAT':
      idat.append(body)
  raw = zlib.decompress(b''.join(idat))
  stride = width * 4
  rows, prev = [], bytearray(stride)
  for y in range(height):
    start = y * (stride + 1)
    kind = raw[start]
    row = bytearray(raw[start + 1:start + 1 + stride])
    if kind == 1:    # Sub
      for i in range(4, stride):
        row[i] = (row[i] + row[i - 4]) & 255
    elif kind == 2:  # Up
      for i in range(stride):
        row[i] = (row[i] + prev[i]) & 255
    elif kind == 3:  # Average
      for i in range(stride):
        left = row[i - 4] if i >= 4 else 0
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 255
    elif kind == 4:  # Paeth
      for i in range(stride):
        a = row[i - 4] if i >= 4 else 0
        b = prev[i]
        c = prev[i - 4] if i >= 4 else 0
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(row)
    prev = row
  return width, height, rows


def png_size(path):
  with open(path, 'rb') as f:
    head = f.read(24)
  return struct.unpack('>II', head[16:24])


def png_bytes(width, height, rows):
  def chunk(kind, body):
    return (struct.pack('>I', len(body)) + kind + body +
            struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff))
  raw = b''.join(b'\x00' + bytes(row) for row in rows)
  return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
          chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def weights(src, dst):
  """For each destination pixel: [(source index, share of it covered)] (area averaging)."""
  scale = src / dst
  out = []
  for d in range(dst):
    lo, hi = d * scale, (d + 1) * scale
    taps, s = [], int(lo)
    while s < hi and s < src:
      cover = min(hi, s + 1) - max(lo, s)
      if cover > 1e-9:
        taps.append((s, cover / scale))
      s += 1
    out.append(taps)
  return out


def resize(image, width, height):
  """Area-averaged downscale, colours weighted by alpha (no dark fringe at the edges)."""
  sw, sh, rows = image
  if (sw, sh) == (width, height):
    return image
  # Premultiplied floats: [r*a, g*a, b*a, a] per pixel.
  wx, wy = weights(sw, width), weights(sh, height)
  horizontal = []
  for row in rows:
    line = [0.0] * (width * 4)
    for x, taps in enumerate(wx):
      r = g = b = a = 0.0
      for s, w in taps:
        i = s * 4
        alpha = row[i + 3] * w
        r += row[i] * alpha; g += row[i + 1] * alpha; b += row[i + 2] * alpha; a += alpha
      o = x * 4
      line[o], line[o + 1], line[o + 2], line[o + 3] = r, g, b, a
    horizontal.append(line)
  out = []
  for taps in wy:
    acc = [0.0] * (width * 4)
    for s, w in taps:
      line = horizontal[s]
      for i in range(width * 4):
        acc[i] += line[i] * w
    row = bytearray(width * 4)
    for x in range(width):
      o = x * 4
      a = acc[o + 3]
      if a > 0:
        row[o] = min(255, round(acc[o] / a))
        row[o + 1] = min(255, round(acc[o + 1] / a))
        row[o + 2] = min(255, round(acc[o + 2] / a))
        row[o + 3] = min(255, round(a))
    out.append(row)
  return width, height, out


class Sizes:
  """The source at any size, each made from the nearest larger one already made."""

  def __init__(self, image):
    self.made = {image[0]: image}

  def get(self, n):
    if n not in self.made:
      base = min(k for k in self.made if k > n)
      # Halve down first: far fewer source pixels for the small sizes.
      while base // 2 >= n * 2 and base % 2 == 0:
        self.made[base // 2] = resize(self.made[base], base // 2, base // 2)
        base //= 2
      self.made[n] = resize(self.made[base], n, n)
    return self.made[n]


def ico_bytes(sizes, wanted):
  """An .ico: 32-bit bitmaps below 256 px, a PNG at 256 (as Windows expects)."""
  entries = []
  for n in wanted:
    _, _, rows = sizes.get(n)
    if n >= 256:
      body = png_bytes(n, n, rows)
    else:
      pixels = bytearray()
      for row in reversed(rows):  # bottom-up, BGRA
        for x in range(n):
          r, g, b, a = row[x * 4:x * 4 + 4]
          pixels += bytes((b, g, r, a))
      mask_stride = ((n + 31) // 32) * 4
      mask = bytearray()
      for row in reversed(rows):
        line = bytearray(mask_stride)
        for x in range(n):
          if row[x * 4 + 3] == 0:
            line[x // 8] |= 0x80 >> (x % 8)
        mask += line
      header = struct.pack('<IiiHHIIiiII', 40, n, n * 2, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
      body = header + bytes(pixels) + bytes(mask)
    entries.append((n, body))
  out = struct.pack('<HHH', 0, 1, len(entries))
  offset = 6 + 16 * len(entries)
  for n, body in entries:
    out += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(body), offset)
    offset += len(body)
  return out + b''.join(body for _, body in entries)


def xpm_text(image, name):
  """An XPM: colours reduced to 4 bits a channel, see-through below half alpha."""
  width, height, rows = image
  chars = [c for c in map(chr, range(35, 127)) if c not in '"\\']
  colours, lines = {}, []
  for row in rows:
    line = []
    for x in range(width):
      r, g, b, a = row[x * 4:x * 4 + 4]
      key = None if a < 128 else '#%02X%02X%02X' % tuple((v >> 4) * 17 for v in (r, g, b))
      line.append(colours.setdefault(key, len(colours)))
    lines.append(line)
  per = 1 if len(colours) <= len(chars) else 2
  code = lambda i: chars[i] if per == 1 else chars[i // len(chars)] + chars[i % len(chars)]
  out = ['/* XPM */', f'static char * {name}[] = {{', f'"{width} {height} {len(colours)} {per}",']
  out += [f'"{code(i)}\tc {key or "None"}",' for key, i in colours.items()]
  out += ['"' + ''.join(code(i) for i in line) + '"' + (',' if y < height - 1 else '};')
          for y, line in enumerate(lines)]
  return '\n'.join(out) + '\n'


def main():
  source, theme = sys.argv[1], sys.argv[2]
  sizes = Sizes(read_png(source))
  pngs = (glob.glob(os.path.join(theme, 'product_logo_[0-9]*.png')) +
          glob.glob(os.path.join(theme, 'linux', 'product_logo_[0-9]*.png')) +
          glob.glob(os.path.join(theme, 'win', 'tiles', '*.png')))
  for path in pngs:
    if path.endswith('_mono.png'):
      continue  # a one-colour silhouette for Linux panels: stays Chromium's
    width, height = png_size(path)
    if width != height:
      continue
    with open(path, 'wb') as f:
      f.write(png_bytes(*sizes.get(width)))
  with open(os.path.join(theme, 'linux', 'product_logo_32.xpm'), 'w', newline='\n') as f:
    f.write(xpm_text(sizes.get(32), 'product_logo_32_xpm'))
  with open(os.path.join(theme, 'win', 'chromium.ico'), 'wb') as f:
    f.write(ico_bytes(sizes, [16, 24, 32, 48, 64, 128, 256]))
  print(f'icons: {len(pngs)} PNG, linux/product_logo_32.xpm, win/chromium.ico')


if __name__ == '__main__':
  main()
