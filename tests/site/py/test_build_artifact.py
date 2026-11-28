import json
import runpy
import sys

import pytest

from conftest import ROOT

SITE = 'https://meridianbrowser.app/'


SHELL = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex">
<link rel="icon" href="../../docs/icon.png">
<title>Lab</title>
</head>
<body>
<img src="../../docs/icon.png">
<script>const pages = [{ src: '../../docs/index.html' }];</script>
</body>
</html>
'''

CONCEPT = '''<img src="../../docs/readme/a.webp"><img src="../../docs/shot.jpg">
<a href="../../docs/guide/index.html">g</a>
<script>const dir = '../../docs/readme/';</script>
<img src="img/local.jpg">
'''

CURRENT = '''<html>
<head>
<link rel="icon" href="icon.png">
<link rel="stylesheet" href="./style.css">
<script data-goatcounter="https://x.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
</head>
<body>
<a href="#install">i</a><a href="https://github.com/x">gh</a><a href="mailto:a@b.c">m</a>
<a href="windows/">w</a><a href="./">home</a><a href="${url}">t</a>
<img src="screenshot.jpg"><img src="data:image/png;base64,AA"><img src="https://x.org/a.png">
<script data-goatcounter="again"></script></body>
</html>
'''


def make_tree(tmp_path, img=True):
  lab = tmp_path / 'site' / 'lab'
  docs = tmp_path / 'docs'
  lab.mkdir(parents=True)
  (docs / 'readme').mkdir(parents=True)
  (docs / 'guide').mkdir()
  (lab / 'index.html').write_text(SHELL)
  (lab / '01-one.html').write_text(CONCEPT)
  (lab / '02-two.html').write_text('<p>no assets</p>\n')
  (lab / 'notes.html').write_text('<p>not a concept</p>\n')
  if img:
    (lab / 'img').mkdir()
    (lab / 'img' / 'local.jpg').write_bytes(b'local')
  (docs / 'index.html').write_text(CURRENT)
  for rel, data in {'icon.png': b'icon', 'readme/a.webp': b'a', 'readme/unused.webp': b'unused',
                    'shot.jpg': b'shot', 'guide/index.html': b'guide', 'screenshot.jpg': b'screen'}.items():
    (docs / rel).write_bytes(data)
  return lab, docs


@pytest.fixture
def tree(artifact, tmp_path, monkeypatch):
  lab, docs = make_tree(tmp_path)
  monkeypatch.setattr(artifact, 'LAB', lab)
  monkeypatch.setattr(artifact, 'DOCS', docs)
  return lab, docs


def files(root):
  return sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file())


def test_layout_and_printed_map(artifact, tree, tmp_path, capsys):
  out = tmp_path / 'out'
  artifact.main([str(out)])
  expected = ['01-one.html', '02-two.html', 'assets/guide/index.html', 'assets/icon.png', 'assets/readme/a.webp',
              'assets/screenshot.jpg', 'assets/shot.jpg', 'current.html', 'img/local.jpg', 'index.html']
  assert files(out) == expected
  printed = json.loads(capsys.readouterr().out)
  # Only the shell is left out (it is published as the page itself); a copied guide page is listed.
  assert printed == {rel: str(out / rel) for rel in expected if rel != 'index.html'}


def test_shell(artifact, tree, tmp_path):
  out = tmp_path / 'out'
  artifact.main([str(out)])
  assert (out / 'index.html').read_text() == (
    '<meta name="robots" content="noindex">\n'
    '<title>Lab</title>\n'
    '<img src="assets/icon.png">\n'
    "<script>const pages = [{ src: 'current.html' }];</script>\n")


def test_concepts_are_localized(artifact, tree, tmp_path):
  out = tmp_path / 'out'
  artifact.main([str(out)])
  assert (out / '01-one.html').read_text() == (
    '<img src="assets/readme/a.webp"><img src="assets/shot.jpg">\n'
    '<a href="assets/guide/index.html">g</a>\n'
    "<script>const dir = 'assets/readme/';</script>\n"
    '<img src="img/local.jpg">\n')
  assert (out / '02-two.html').read_text() == '<p>no assets</p>\n'
  assert not (out / 'notes.html').exists()


def test_current_page(artifact, tree, tmp_path):
  out = tmp_path / 'out'
  artifact.main([str(out)])
  assert (out / 'current.html').read_text() == f'''<html>
<head>
<link rel="icon" href="assets/icon.png">
<link rel="stylesheet" href="{SITE}style.css">
</head>
<body>
<a href="#install">i</a><a href="https://github.com/x">gh</a><a href="mailto:a@b.c">m</a>
<a href="{SITE}windows/">w</a><a href="{SITE}">home</a><a href="${{url}}">t</a>
<img src="assets/screenshot.jpg"><img src="data:image/png;base64,AA"><img src="https://x.org/a.png">
</body>
</html>
'''


def test_copies_only_used_assets_byte_for_byte(artifact, tree, tmp_path):
  _, docs = tree
  out = tmp_path / 'out'
  artifact.main([str(out)])
  for rel in files(out / 'assets'):
    assert (out / 'assets' / rel).read_bytes() == (docs / rel).read_bytes()
  assert not (out / 'assets' / 'readme' / 'unused.webp').exists()
  assert (out / 'img' / 'local.jpg').read_bytes() == b'local'


def test_replaces_the_out_dir(artifact, tree, tmp_path):
  out = tmp_path / 'out'
  (out / 'assets').mkdir(parents=True)
  (out / 'stale.html').write_text('old')
  (out / 'assets' / 'stale.png').write_bytes(b'old')
  artifact.main([str(out)])
  assert 'stale.html' not in files(out) and 'assets/stale.png' not in files(out)


def test_without_img(artifact, tmp_path, monkeypatch, capsys):
  lab, docs = make_tree(tmp_path, img=False)
  monkeypatch.setattr(artifact, 'LAB', lab)
  monkeypatch.setattr(artifact, 'DOCS', docs)
  out = tmp_path / 'out'
  artifact.main([str(out)])
  assert not (out / 'img').exists()
  assert 'img/local.jpg' not in json.loads(capsys.readouterr().out)


def test_runs_do_not_share_assets(artifact, tree, tmp_path):
  lab, docs = tree
  artifact.main([str(tmp_path / 'first')])
  (lab / '01-one.html').write_text('<p>none</p>\n')
  (docs / 'shot.jpg').unlink()
  out = tmp_path / 'second'
  artifact.main([str(out)])
  assert 'assets/shot.jpg' not in files(out)


def test_missing_asset_fails(artifact, tree, tmp_path):
  _, docs = tree
  (docs / 'readme' / 'a.webp').unlink()
  with pytest.raises(FileNotFoundError):
    artifact.main([str(tmp_path / 'out')])


def test_real_lab(tmp_path, monkeypatch, capsys):
  out = tmp_path / 'out'
  monkeypatch.setattr(sys, 'argv', ['build_artifact.py', str(out)])
  runpy.run_path(str(ROOT / 'site' / 'lab' / 'build_artifact.py'), run_name='__main__')
  printed = json.loads(capsys.readouterr().out)
  lab, docs = ROOT / 'site' / 'lab', ROOT / 'docs'

  concepts = sorted(p.name for p in lab.glob('0*.html'))
  assert concepts and all(name in printed for name in concepts)
  assert 'index.html' not in printed and 'current.html' in printed
  assert set(printed) == {rel for rel in files(out) if rel != 'index.html'}

  shell = (out / 'index.html').read_text()
  for gone in ('<!doctype html>', '<html', '</html>', '<head>', '</head>', '<body', '</body>', '<meta charset',
               '<link rel="icon"'):
    assert gone not in shell
  assert "'current.html'" in shell and '../../docs/' not in shell

  for name in concepts:
    assert '../../docs/' not in (out / name).read_text()

  current = (out / 'current.html').read_text()
  assert '<script data-goatcounter' not in current
  assert 'src="assets/' in current and '../../docs/' not in current
  assert f'href="{SITE}' in current

  for rel in printed:
    if rel.startswith('img/'):
      assert (out / rel).read_bytes() == (lab / rel).read_bytes()
    if rel.startswith('assets/'):
      assert (out / rel).read_bytes() == (docs / rel.removeprefix('assets/')).read_bytes()
  assert (lab / 'img').is_dir() and any(rel.startswith('img/') for rel in printed)
