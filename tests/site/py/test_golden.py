import re

from conftest import ROOT

BASE = 'https://meridianbrowser.app/'
DOCS = ROOT / 'docs'


def committed_urls():
  return re.findall(r'<loc>([^<]*)</loc>', (DOCS / 'sitemap.xml').read_text(encoding='utf-8'))


def path_of(url):
  path = url[len(BASE):]
  return path + 'index.html' if path == '' or path.endswith('/') else path


def test_build_matches_committed_docs(build, tmp_path, capsys):
  out = tmp_path / 'docs'
  build.main(['--out', str(out)])
  urls = capsys.readouterr().out.splitlines()
  assert urls == committed_urls()

  # The committed sitemap names the built pages; privacy.html is hand-written, sitemap.xml is built.
  expected = {path_of(u) for u in urls if u != BASE + 'privacy.html'} | {'sitemap.xml'}
  written = {p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()}
  assert written == expected

  differ = [rel for rel in sorted(written) if (out / rel).read_bytes() != (DOCS / rel).read_bytes()]
  assert differ == []
