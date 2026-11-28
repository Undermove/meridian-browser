"""The built site holds together: links, fragments, canonical URLs and the sitemap.

test_golden only checks docs/ equals the build; these check the build is right. The site served
is the build plus the hand-written files in docs/ (privacy.html, icon.png, images...).
"""

import contextlib
import io
import json
import posixpath
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

from conftest import ROOT

BASE = 'https://meridianbrowser.app/'
DOCS = ROOT / 'docs'
# docs/ pages the build does not write. demo/plain.html is noindex, so the sitemap leaves it out.
HAND_WRITTEN_HTML = {'privacy.html', 'demo/plain.html'}
EXTERNAL = ('http:', 'https:', 'mailto:', 'data:', 'javascript:', 'tel:')


class Page(HTMLParser):
  def __init__(self, text):
    super().__init__(convert_charrefs=True)
    self.urls = []  # (attr, value)
    self.ids = set()
    self.canonical = None
    self.og_url = None
    self.noindex = False
    self.hreflang = {}
    self._ld = None
    self.feed(text)

  def handle_starttag(self, tag, attrs):
    a = dict(attrs)
    for key in ('id', 'name') if tag == 'a' else ('id',):
      if a.get(key):
        self.ids.add(a[key])
    for key in ('href', 'src'):
      if a.get(key) is not None:
        self.urls.append((key, a[key]))
    if tag == 'meta' and (a.get('content') or '').startswith(BASE):
      self.urls.append(('content', a['content']))
    if tag == 'meta' and a.get('property') == 'og:url':
      self.og_url = a.get('content')
    if tag == 'meta' and a.get('name') == 'robots' and 'noindex' in (a.get('content') or ''):
      self.noindex = True
    if tag == 'link' and a.get('rel') == 'canonical':
      self.canonical = a.get('href')
    if tag == 'link' and a.get('rel') == 'alternate' and a.get('hreflang'):
      self.hreflang[a['hreflang']] = a.get('href')
    if tag == 'script' and a.get('type') == 'application/ld+json':
      self._ld = []

  def handle_data(self, data):
    if self._ld is not None:
      self._ld.append(data)

  def handle_endtag(self, tag):
    if tag == 'script' and self._ld is not None:
      def walk(v):
        if isinstance(v, dict):
          for x in v.values():
            walk(x)
        elif isinstance(v, list):
          for x in v:
            walk(x)
        elif isinstance(v, str) and v.startswith(BASE):
          self.urls.append(('ld+json', v))
      walk(json.loads(''.join(self._ld)))
      self._ld = None


class Site:
  """Files looked up in `roots` in order: the build first, then the hand-written docs/."""

  def __init__(self, *roots):
    self.roots = [Path(r) for r in roots]
    self._pages = {}

  def file(self, rel):
    for r in self.roots:
      if (r / rel).is_file():
        return r / rel
    return None

  def is_dir(self, rel):
    return any((r / rel).is_dir() for r in self.roots)

  def html_files(self):
    seen = set()
    for r in self.roots:
      seen |= {p.relative_to(r).as_posix() for p in r.rglob('*.html')}
    return sorted(seen)

  def page(self, rel):
    if rel not in self._pages:
      self._pages[rel] = Page(self.file(rel).read_text(encoding='utf-8'))
    return self._pages[rel]

  def resolve(self, page_rel, url):
    """(target path from the site root, fragment), or None for a link off the site.
    The target is '' when the link leaves the site root."""
    if url.startswith(BASE):
      url = '/' + url[len(BASE):]
    if url.lower().startswith(EXTERNAL) or url.startswith('//') or '${' in url:
      return None
    parts = urlsplit(url)
    path = unquote(parts.path)
    if path == '':
      return page_rel, parts.fragment
    if path.startswith('/'):
      target = posixpath.normpath(path.lstrip('/') or '.')
    else:
      target = posixpath.normpath(posixpath.join(posixpath.dirname(page_rel), path))
    if target == '..' or target.startswith('../'):
      return '', parts.fragment
    if target == '.':
      target = 'index.html'
    elif path.endswith('/') or self.is_dir(target):
      target += '/index.html'
    return target, parts.fragment

  def links(self):
    for rel in self.html_files():
      for attr, url in self.page(rel).urls:
        r = self.resolve(rel, url)
        if r is not None:
          yield rel, attr, url, r[0], r[1]


def url_of(rel):
  if rel == 'index.html':
    return BASE
  if rel.endswith('/index.html'):
    return BASE + rel[:-len('index.html')]
  return BASE + rel


def broken_links(site):
  return [f'{rel}: {attr}="{url}"' for rel, attr, url, target, _ in site.links()
          if not target or site.file(target) is None]


def missing_fragments(site):
  out = []
  for rel, attr, url, target, frag in site.links():
    if frag and target.endswith('.html') and site.file(target) and frag not in site.page(target).ids:
      out.append(f'{rel}: {attr}="{url}" (no id "{frag}" in {target})')
  return out


def ru_home_links(site):
  return [f'{rel}: {attr}="{url}"' for rel, attr, url, target, _ in site.links()
          if target == 'ru/index.html']


def canonical_problems(site):
  """A page's canonical names the page itself; og:url agrees; hreflang alternates link back."""
  out = []
  for rel in site.html_files():
    p = site.page(rel)
    if p.canonical is None:
      if not p.noindex:
        out.append(f'{rel}: no canonical')
      continue
    if p.canonical != url_of(rel):
      out.append(f'{rel}: canonical {p.canonical}')
    if p.og_url is not None and p.og_url != p.canonical:
      out.append(f'{rel}: og:url {p.og_url} != canonical')
    for lang, href in p.hreflang.items():
      r = site.resolve(rel, href)
      if lang == 'x-default' or not r or not r[0] or site.file(r[0]) is None:
        continue
      if url_of(rel) not in site.page(r[0]).hreflang.values():
        out.append(f'{rel}: hreflang {lang} {href} does not link back')
  return out


def sitemap_problems(site, sitemap):
  """The sitemap lists every indexable page once (a noindex page is left out), by its canonical."""
  locs = re.findall(r'<loc>([^<]*)</loc>', Path(sitemap).read_text(encoding='utf-8'))
  want = {url_of(rel) for rel in site.html_files() if not site.page(rel).noindex}
  out = [f'listed twice: {u}' for u in sorted({u for u in locs if locs.count(u) > 1})]
  out += [f'missing: {u}' for u in sorted(want - set(locs))]
  out += [f'not an indexable page: {u}' for u in sorted(set(locs) - want)]
  return out


@pytest.fixture(scope='module')
def built(build, tmp_path_factory):
  out = tmp_path_factory.mktemp('site') / 'docs'
  with contextlib.redirect_stdout(io.StringIO()):
    build.main(['--out', str(out)])
  return out


@pytest.fixture(scope='module')
def site(built):
  return Site(built, DOCS)


def test_every_local_link_and_source_resolves(site):
  assert broken_links(site) == []


def test_every_fragment_exists_on_its_page(site):
  assert missing_fragments(site) == []


def test_install_fragment_links_reach_the_home_page(site):
  # The home page is English only: every page's download link goes to the root's #install.
  hits = {(rel, target) for rel, _, _, target, frag in site.links() if frag == 'install'}
  assert {rel for rel, _ in hits} >= {'changelog.html', 'ru/changelog.html', 'windows/index.html',
                                      'ru/windows/index.html'}
  assert {target for _, target in hits} == {'index.html'}
  assert 'install' in site.page('index.html').ids


def test_nothing_links_to_the_removed_russian_home_page(site):
  assert ru_home_links(site) == []
  assert site.file('ru/index.html') is None


def test_canonical_hreflang_and_og_url_map_to_the_pages(site):
  assert canonical_problems(site) == []
  assert 'ru' not in site.page('index.html').hreflang


def test_sitemap_lists_exactly_the_indexable_pages(site, built):
  assert sitemap_problems(site, built / 'sitemap.xml') == []
  assert sitemap_problems(site, DOCS / 'sitemap.xml') == []
  assert site.page('demo/plain.html').noindex


def test_docs_holds_no_stale_built_pages(built):
  # A page the build stopped writing (like ru/index.html) would linger in docs/ and still be served.
  built_html = {p.relative_to(built).as_posix() for p in built.rglob('*.html')}
  docs_html = {p.relative_to(DOCS).as_posix() for p in DOCS.rglob('*.html')}
  assert docs_html == built_html | HAND_WRITTEN_HTML


def test_hand_written_files_the_build_links_to_are_in_docs(site, built):
  targets = {target for rel, _, _, target, _ in site.links() if (built / rel).is_file()}
  hand = {t for t in targets if t and not (built / t).is_file()}
  assert {'privacy.html', 'icon.png', 'screenshot.jpg', 'app-split.jpg'} <= hand
  assert [t for t in sorted(hand) if not (DOCS / t).is_file()] == []


# The checkers, each shown failing on a broken copy.

def write(root, files):
  for rel, text in files.items():
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')
  return root


def head(rel, extra=''):
  return f'<link rel="canonical" href="{url_of(rel)}">{extra}'


def test_red_broken_links(tmp_path):
  s = Site(write(tmp_path, {
    'index.html': head('index.html') + '<a href="gone/">x</a><img src="nope.png"><a href="../up.html">u</a>'
                  '<a href="https://meridianbrowser.app/lost.html">l</a><a href="ok/">ok</a>'
                  '<a href="https://example.com/">e</a><a href="mailto:a@b">m</a><a href="#top">t</a>',
    'ok/index.html': head('ok/index.html') + '<a href="../">home</a><a href="./">self</a><img src="../icon.png">',
    'icon.png': '',
  }))
  assert broken_links(s) == [
    'index.html: href="gone/"',
    'index.html: src="nope.png"',
    'index.html: href="../up.html"',
    'index.html: href="https://meridianbrowser.app/lost.html"',
  ]


def test_red_missing_fragments(tmp_path):
  s = Site(write(tmp_path, {
    'index.html': head('index.html') + '<a id="top"></a><a name="old"></a>',
    'a/index.html': head('a/index.html') + '<a href="../#install">i</a><a href="../#top">t</a>'
                    '<a href="../#old">o</a><a href="#here">h</a><a href="#">x</a><b id="here"></b>',
  }))
  assert missing_fragments(s) == ['a/index.html: href="../#install" (no id "install" in index.html)']


def test_red_ru_home_links(tmp_path):
  s = Site(write(tmp_path, {
    'index.html': head('index.html') + '<a href="ru/">r</a><a href="ru/index.html">r</a>',
    'ru/changelog.html': head('ru/changelog.html') + '<a href="./">r</a><a href="../">ok</a>',
  }))
  assert ru_home_links(s) == ['index.html: href="ru/"', 'index.html: href="ru/index.html"',
                              'ru/changelog.html: href="./"']


def test_red_canonical_problems(tmp_path):
  alt = '<link rel="alternate" hreflang="{}" href="{}">'
  s = Site(write(tmp_path, {
    'index.html': '<link rel="canonical" href="https://meridianbrowser.app/ru/">',
    'a.html': head('a.html', '<meta property="og:url" content="https://meridianbrowser.app/b.html">'
                   + alt.format('ru', BASE + 'ru/a.html')),
    'ru/a.html': head('ru/a.html'),
    'b.html': '',
    'n.html': '<meta name="robots" content="noindex">',
  }))
  assert canonical_problems(s) == [
    'a.html: og:url https://meridianbrowser.app/b.html != canonical',
    'a.html: hreflang ru https://meridianbrowser.app/ru/a.html does not link back',
    'b.html: no canonical',
    'index.html: canonical https://meridianbrowser.app/ru/',
  ]


def test_red_sitemap_problems(tmp_path):
  root = write(tmp_path / 'site', {
    'index.html': head('index.html'),
    'a/index.html': head('a/index.html'),
    'n.html': '<meta name="robots" content="noindex">',
  })
  sitemap = write(tmp_path, {'sitemap.xml': ''.join(f'<url><loc>{BASE}{p}</loc></url>'
                                                    for p in ('', '', 'n.html', 'gone/'))}) / 'sitemap.xml'
  assert sitemap_problems(Site(root), sitemap) == [
    f'listed twice: {BASE}',
    f'missing: {BASE}a/',
    f'not an indexable page: {BASE}gone/',
    f'not an indexable page: {BASE}n.html',
  ]


def test_red_later_roots_fill_in_files_the_first_lacks(tmp_path):
  built, docs = tmp_path / 'built', tmp_path / 'docs'
  write(built, {'index.html': head('index.html') + '<img src="icon.png"><a href="privacy.html">p</a>'})
  assert broken_links(Site(built)) == ['index.html: src="icon.png"', 'index.html: href="privacy.html"']
  write(docs, {'icon.png': '', 'privacy.html': head('privacy.html')})
  assert broken_links(Site(built, docs)) == []


def test_red_a_broken_copy_of_the_real_build(built, tmp_path):
  copy = tmp_path / 'docs'
  shutil.copytree(built, copy)
  def sub(rel, old, new):
    text = (copy / rel).read_text(encoding='utf-8')
    assert text.count(old) >= 1, (rel, old)
    (copy / rel).write_text(text.replace(old, new), encoding='utf-8')
  # From ru/, `./` is the removed Russian home page.
  sub('ru/changelog.html', 'href="../#install"', 'href="./#install"')
  sub('ru/windows/index.html', 'src="../../icon.png"', 'src="../icon.png"')
  sub('index.html', 'id="install"', 'id="get"')
  (copy / 'sitemap.xml').write_text((copy / 'sitemap.xml').read_text().replace(
    f'<url><loc>{BASE}windows/</loc></url>', ''))
  s = Site(copy, DOCS)
  assert 'ru/changelog.html: href="./#install"' in broken_links(s)
  assert 'ru/windows/index.html: src="../icon.png"' in broken_links(s)
  assert ru_home_links(s) == ['ru/changelog.html: href="./#install"']
  assert 'changelog.html: href="./#install" (no id "install" in index.html)' in missing_fragments(s)
  assert sitemap_problems(s, copy / 'sitemap.xml') == [f'missing: {BASE}windows/']
