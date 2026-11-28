import json
import re
import runpy
import sys

import pytest

from conftest import ROOT

BASE = 'https://meridianbrowser.app/'


INDEX = '''<!doctype html>
<html lang="en">
<head>
<title>Home</title>
<meta name="description" content="Home &amp; more">
<link rel="canonical" href="https://meridianbrowser.app/">
</head>
<body data-lang="en">
<a href="changelog.html">c</a><img src="icon.png">
<div class="qa">
<article class="q"><h3>Is it <b>free</b>?</h3><p>Yes &amp; open.</p></article>
<article><h3>Mac?</h3><p>And <a href="windows/">Windows</a>.</p></article>
</div>
</body>
</html>
'''

CHANGELOG = '''<!doctype html>
<html lang="en">
<head>
<title>What's new</title>
<meta name="description" content="en desc">
<meta property="og:title" content="en og">
<meta property="og:description" content="en ogd">
<link rel="canonical" href="https://meridianbrowser.app/changelog.html">
</head>
<body data-lang="en">
<div class="lang" role="group"><button data-set-lang="en">EN</button></div>
<h1><span lang="en">New</span><span lang="ru">Новое</span></h1>
<a href="windows/">w</a><a href="./">home</a><img src="changelog-images/a.png">
<script>
  let lang = '';
  try { lang = localStorage.getItem('lang') || ''; } catch {}
  if (lang !== 'en') lang = 'en';
</script>
</body>
</html>
'''


def guide(meta, body='<p>Body</p>\n'):
  return '<!--' + json.dumps(meta) + '-->\n' + body


def make_site(tmp_path):
  site = tmp_path / 'site'
  (site / 'pages').mkdir(parents=True)
  (site / 'guides' / 'ru').mkdir(parents=True)
  (site / 'pages' / 'index.html').write_text(INDEX, encoding='utf-8')
  (site / 'pages' / 'changelog.html').write_text(CHANGELOG, encoding='utf-8')
  (site / 'guide_template.html').write_text((ROOT / 'site' / 'guide_template.html').read_text(encoding='utf-8'),
                                            encoding='utf-8')
  # Above the default 99, so `order` and name order disagree.
  full = {'nav': 'Alpha', 'order': 100, 'title': 'A & B', 'description': 'Say "hi"', 'og_image': 'a.png',
          'h1': 'Alpha', 'lede': 'Lede', 'updated': 'Today'}
  (site / 'guides' / 'alpha.html').write_text(guide(full), encoding='utf-8')
  (site / 'guides' / 'ru' / 'alpha.html').write_text(
    guide(dict(full, nav='Альфа', title='Альфа'), '<p><a href="../">home</a><img src="../icon.png"></p>\n'),
    encoding='utf-8')
  # No og_image, lede, updated or order: the defaults apply.
  (site / 'guides' / 'beta.html').write_text(guide({'nav': 'Beta', 'title': 'Beta', 'description': 'd', 'h1': 'Beta'}),
                                             encoding='utf-8')
  (site / 'guides' / 'notes.txt').write_text('not a guide', encoding='utf-8')
  return site


@pytest.fixture
def site(build, tmp_path, monkeypatch):
  s = make_site(tmp_path)
  monkeypatch.setattr(build, 'SITE', str(s))
  return s


def test_url_of(build):
  assert build.url_of('index', 'en') == BASE
  assert build.url_of('index', 'ru') == BASE + 'ru/'
  assert build.url_of('changelog', 'en') == BASE + 'changelog.html'
  assert build.url_of('changelog', 'ru') == BASE + 'ru/changelog.html'


def test_guide_url(build):
  assert build.guide_url('windows', 'en') == BASE + 'windows/'
  assert build.guide_url('windows', 'ru') == BASE + 'ru/windows/'


def test_strip_lang_no_spans(build):
  assert build.strip_lang('<p>plain</p>', 'en') == '<p>plain</p>'


def test_strip_lang_keeps_one_language(build):
  text = 'a<span lang="en">E</span><span lang="ru">R</span>b'
  assert build.strip_lang(text, 'en') == 'aEb'
  assert build.strip_lang(text, 'ru') == 'aRb'


def test_strip_lang_nested_spans(build):
  text = ('<span lang="en">x<span class="k">y</span>z</span>'
          '<span lang="ru">п<span class="k">р<span>с</span></span>т</span>.')
  assert build.strip_lang(text, 'en') == 'x<span class="k">y</span>z.'
  assert build.strip_lang(text, 'ru') == 'п<span class="k">р<span>с</span></span>т.'


def test_strip_lang_nested_lang_spans_inside_a_kept_one(build):
  text = '<span lang="en">a<span lang="ru">b</span>c<span lang="en">d</span></span>'
  assert build.strip_lang(text, 'en') == 'acd'


def test_strip_lang_keeps_hreflang(build):
  text = '<a hreflang="ru" href="x">x</a><span lang="ru">r</span>'
  assert build.strip_lang(text, 'en') == '<a hreflang="ru" href="x">x</a>'


def test_strip_lang_unclosed(build):
  with pytest.raises(ValueError, match='unclosed <span lang> at 2'):
    build.strip_lang('ab<span lang="en">x<span>y</span>', 'en')


def test_relocate_depth_zero_is_unchanged(build):
  text = '<a href="a.html">a</a>'
  assert build.relocate(text, 0) is text


@pytest.mark.parametrize('value', [
  'https://x.org/a', 'mailto:a@b.c', 'data:image/png;base64,AA', 'tel:+1', '#install', '/abs.png', '../up.png', '',
  'img/${name}.png',
])
def test_relocate_leaves_absolute_and_odd_values(build, value):
  text = f'<a href="{value}">x</a>'
  assert build.relocate(text, 1) == text


@pytest.mark.parametrize('value, out', [
  ('a.png', '../a.png'),
  ('./', '../'),
  ('.', '../'),
  ('./a.png', '../a.png'),
  ('windows/#x', '../windows/#x'),
])
def test_relocate_moves_relative_values(build, value, out):
  assert build.relocate(f'<img src="{value}">', 1) == f'<img src="{out}">'


def test_relocate_depth_two_and_single_quotes(build):
  assert build.relocate("<img src='a.png'>", 2) == "<img src='../../a.png'>"


@pytest.mark.parametrize('value', [
  'changelog.html', 'changelog.html#v1', 'arc-shutdown/', 'import-from-arc/', 'windows/', 'developers/',
  'arc-alternatives/#top',
])
def test_relocate_siblings_stay(build, value):
  text = f'<a href="{value}">x</a>'
  assert build.relocate(text, 1, siblings=True) == text
  assert build.relocate(text, 1) == f'<a href="../{value}">x</a>'


def test_relocate_siblings_only_for_href(build):
  assert build.relocate('<img src="changelog.html">', 1, siblings=True) == '<img src="../changelog.html">'


def test_relocate_non_sibling_with_siblings_on(build):
  assert build.relocate('<a href="back-up-arc/">x</a>', 1, siblings=True) == '<a href="../back-up-arc/">x</a>'


def test_alternates(build):
  assert build.alternates('changelog') == (
    f'<link rel="alternate" hreflang="en" href="{BASE}changelog.html">\n'
    f'<link rel="alternate" hreflang="ru" href="{BASE}ru/changelog.html">\n'
    f'<link rel="alternate" hreflang="x-default" href="{BASE}changelog.html">')


def test_set_meta_name_and_property(build):
  text = '<meta name="description" content="old"><meta property="og:title" content="old">'
  text = build.set_meta(text, 'description', 'a "b" & c')
  text = build.set_meta(text, 'og:title', 'T', prop=True)
  assert text == '<meta name="description" content="a &quot;b&quot; &amp; c"><meta property="og:title" content="T">'


def test_set_meta_replaces_only_the_first(build):
  text = '<meta name="d" content="1"><meta name="d" content="2">'
  assert build.set_meta(text, 'd', 'x') == '<meta name="d" content="x"><meta name="d" content="2">'


def test_set_meta_missing_asserts(build):
  with pytest.raises(AssertionError, match='og:title'):
    build.set_meta('<meta name="og:title" content="x">', 'og:title', 'y', prop=True)


def test_faq_items(build):
  assert build.faq_items(INDEX) == [('Is it free?', 'Yes & open.'), ('Mac?', 'And Windows.')]


def test_faq_items_ignores_articles_before_the_questions(build):
  text = '<article><h3>no</h3><p>no</p></article><div class="qa"><article><h3>Q</h3><p>A</p></article>'
  assert build.faq_items(text) == [('Q', 'A')]


def test_faq_items_without_questions_block(build):
  with pytest.raises(ValueError):
    build.faq_items('<p>nothing</p>')


def test_structured_data(build):
  out = build.structured_data(INDEX, 'ru')
  blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', out)
  assert len(blocks) == 2 and out.count('\n') == 1
  app, faq = (json.loads(b) for b in blocks)
  assert app['@type'] == 'SoftwareApplication'
  assert app['url'] == BASE + 'ru/'
  assert app['description'] == 'Home &amp; more'
  assert app['image'] == BASE + 'screenshot.jpg'
  assert faq['@type'] == 'FAQPage' and faq['inLanguage'] == 'ru'
  assert faq['mainEntity'][0] == {'@type': 'Question', 'name': 'Is it free?',
                                  'acceptedAnswer': {'@type': 'Answer', 'text': 'Yes & open.'}}


def test_structured_data_keeps_non_ascii(build):
  text = INDEX.replace('Mac?', 'Мак?')
  assert 'Мак?' in build.structured_data(text, 'en')


def test_structured_data_with_no_questions_asserts(build):
  text = '<meta name="description" content="d"><div class="qa"></div>'
  with pytest.raises(AssertionError, match='no Questions'):
    build.structured_data(text, 'en')


def test_build_page_english_only(build, site, tmp_path):
  docs = tmp_path / 'out'
  assert build.build_page('index', str(docs)) == [BASE]
  assert sorted(p.relative_to(docs).as_posix() for p in docs.rglob('*') if p.is_file()) == ['index.html']
  text = (docs / 'index.html').read_text(encoding='utf-8')
  assert f'<link rel="canonical" href="{BASE}">\n<meta property="og:locale" content="en_US">\n<script' in text
  assert 'hreflang' not in text
  assert '"@type": "FAQPage"' in text
  assert '<a href="changelog.html">c</a><img src="icon.png">' in text


def test_build_page_bilingual(build, site, tmp_path):
  docs = tmp_path / 'out'
  assert build.build_page('changelog', str(docs)) == [BASE + 'changelog.html', BASE + 'ru/changelog.html']
  en = (docs / 'changelog.html').read_text(encoding='utf-8')
  ru = (docs / 'ru' / 'changelog.html').read_text(encoding='utf-8')

  assert '<html lang="en">' in en and '<body data-lang="en">' in en
  assert '<h1>New</h1>' in en and 'Новое' not in en
  assert (f'<a class="link lang-link" href="{BASE}ru/changelog.html" hreflang="ru">Русский</a>') in en
  assert 'class="lang"' not in en
  assert ("<script>\n  let lang = document.documentElement.lang === 'ru' ? 'ru' : 'en';\n</script>") in en
  assert (f'<link rel="canonical" href="{BASE}changelog.html">\n'
          + build.alternates('changelog') + '\n<meta property="og:locale" content="en_US">') in en
  assert '<title>What\'s new</title>' in en and 'content="en desc"' in en
  assert 'application/ld+json' not in en
  assert '<a href="windows/">w</a><a href="./">home</a><img src="changelog-images/a.png">' in en

  meta = build.RU_META['changelog']
  assert '<html lang="ru">' in ru and '<body data-lang="ru">' in ru
  assert '<h1>Новое</h1>' in ru
  assert f'<a class="link lang-link" href="{BASE}changelog.html" hreflang="en">English</a>' in ru
  assert f'<title>{meta["title"]}</title>' in ru
  assert f'<meta name="description" content="{meta["description"]}">' in ru
  assert f'<meta property="og:title" content="{meta["og_title"]}">' in ru
  assert f'<meta property="og:description" content="{meta["og_description"]}">' in ru
  assert (f'<link rel="canonical" href="{BASE}ru/changelog.html">\n'
          + build.alternates('changelog') + '\n<meta property="og:locale" content="ru_RU">') in ru
  assert '<a href="windows/">w</a><a href="../">home</a><img src="../changelog-images/a.png">' in ru


def test_build_page_bilingual_without_switch_asserts(build, site, tmp_path):
  page = site / 'pages' / 'changelog.html'
  page.write_text(CHANGELOG.replace('<div class="lang" role="group"><button data-set-lang="en">EN</button></div>', ''),
                  encoding='utf-8')
  with pytest.raises(AssertionError, match='changelog'):
    build.build_page('changelog', str(tmp_path / 'out'))


def test_build_page_without_canonical_asserts(build, site, tmp_path):
  page = site / 'pages' / 'index.html'
  page.write_text(INDEX.replace('<link rel="canonical" href="https://meridianbrowser.app/">', ''), encoding='utf-8')
  with pytest.raises(AssertionError, match='index'):
    build.build_page('index', str(tmp_path / 'out'))


@pytest.mark.parametrize('value, out', [
  ('../icon.png', '../../icon.png'),
  ('../privacy.html', '../../privacy.html'),
  ('../changelog-images/a b.png', '../../changelog-images/a b.png'),
  ('../screenshot.jpg', '../../screenshot.jpg'),
  ('../screenshot-2x.png', '../../screenshot-2x.png'),
  ('../#install', '../../#install'),
  ('../', '../../'),
  ('../windows/', '../windows/'),
  ('../changelog.html', '../changelog.html'),
  ('https://x.org/', 'https://x.org/'),
])
def test_to_root(build, value, out):
  assert build.to_root(f'<a href="{value}">') == f'<a href="{out}">'
  assert build.to_root(f'<img src="{value}">') == f'<img src="{out}">'


def test_read_guide(build, tmp_path):
  p = tmp_path / 'g.html'
  p.write_text('\n  <!--{"nav": "N"}-->\n\n<p>x</p>\n', encoding='utf-8')
  assert build.read_guide(str(p)) == ({'nav': 'N'}, '<p>x</p>\n')


GUIDES = [
  {'slug': 'alpha', 'nav': 'Alpha', 'nav_ru': 'Альфа', 'order': 2},
  {'slug': 'beta', 'nav': 'B & b', 'nav_ru': None, 'order': 99},
  {'slug': 'gamma', 'nav': 'Gamma', 'nav_ru': 'Гамма <3', 'order': 3},
]


def test_build_guide_english_with_russian(build, site, tmp_path):
  docs = tmp_path / 'out'
  template = (site / 'guide_template.html').read_text(encoding='utf-8')
  assert build.build_guide('alpha', 'en', template, GUIDES, str(docs)) == BASE + 'alpha/'
  page = (docs / 'alpha' / 'index.html').read_text(encoding='utf-8')
  assert '<title>A &amp; B</title>' in page
  assert '<meta name="description" content="Say &quot;hi&quot;">' in page
  assert f'<meta property="og:image" content="{BASE}a.png">' in page
  assert f'<link rel="canonical" href="{BASE}alpha/">\n<link rel="alternate" hreflang="en" href="{BASE}alpha/">' in page
  assert f'<link rel="alternate" hreflang="x-default" href="{BASE}alpha/">' in page
  assert f'<a class="link" href="{BASE}ru/alpha/" hreflang="ru">Русский</a>' in page
  assert '<p class="lede">Lede</p>' in page and '<p class="updated">Today</p>' in page
  assert ('<li><a href="../beta/">B &amp; b</a></li>\n<li><a href="../gamma/">Gamma</a></li>\n') in page
  assert '../alpha/' not in page
  assert '{{' not in page and 'Download Meridian' in page


def test_build_guide_russian(build, site, tmp_path):
  docs = tmp_path / 'out'
  template = (site / 'guide_template.html').read_text(encoding='utf-8')
  assert build.build_guide('alpha', 'ru', template, GUIDES, str(docs)) == BASE + 'ru/alpha/'
  page = (docs / 'ru' / 'alpha' / 'index.html').read_text(encoding='utf-8')
  assert f'<a class="link" href="{BASE}alpha/" hreflang="en">English</a>' in page
  assert '<title>Альфа</title>' in page
  assert '<li><a href="../gamma/">Гамма &lt;3</a></li>\n' in page
  assert '../beta/' not in page
  for en, ru in build.GUIDE_RU:
    assert ru in page
  assert 'Download Meridian' not in page and 'content="ru_RU"' in page
  assert '<p><a href="../../">home</a><img src="../../icon.png"></p>' in page
  assert '<link rel="icon" href="../../icon.png">' in page


def test_build_guide_without_russian(build, site, tmp_path):
  docs = tmp_path / 'out'
  template = (site / 'guide_template.html').read_text(encoding='utf-8')
  assert build.build_guide('beta', 'en', template, GUIDES, str(docs)) == BASE + 'beta/'
  page = (docs / 'beta' / 'index.html').read_text(encoding='utf-8')
  assert 'hreflang' not in page
  assert f'<link rel="canonical" href="{BASE}beta/">\n\n' in page
  assert f'<meta property="og:image" content="{BASE}screenshot.jpg">' in page
  assert '<p class="lede"></p>' in page and '<p class="updated"></p>' in page


def test_build_guide_leftover_placeholder_asserts(build, site, tmp_path):
  with pytest.raises(AssertionError, match='alpha'):
    build.build_guide('alpha', 'en', '{{title}} {{unknown}}', GUIDES, str(tmp_path / 'out'))


def test_build_guide_russian_missing_template_string_asserts(build, site, tmp_path):
  template = (site / 'guide_template.html').read_text(encoding='utf-8').replace('>Privacy</a>', '>Policy</a>')
  with pytest.raises(AssertionError, match='>Privacy</a>'):
    build.build_guide('alpha', 'ru', template, GUIDES, str(tmp_path / 'out'))


EXPECTED = [BASE, BASE + 'changelog.html', BASE + 'ru/changelog.html', BASE + 'beta/', BASE + 'alpha/',
            BASE + 'ru/alpha/', BASE + 'privacy.html']


def files(root):
  return sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file())


def test_main_out(build, site, tmp_path, capsys):
  docs = tmp_path / 'out'
  build.main(['--out', str(docs)])
  assert capsys.readouterr().out == '\n'.join(EXPECTED) + '\n'
  assert files(docs) == ['alpha/index.html', 'beta/index.html', 'changelog.html', 'index.html',
                         'ru/alpha/index.html', 'ru/changelog.html', 'sitemap.xml']
  assert (docs / 'sitemap.xml').read_text() == (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + ''.join(f'  <url><loc>{u}</loc></url>\n' for u in EXPECTED) + '</urlset>\n')
  alpha = (docs / 'alpha' / 'index.html').read_text(encoding='utf-8')
  assert '<li><a href="../beta/">Beta</a></li>' in alpha


def test_main_defaults_to_docs(build, site, tmp_path, monkeypatch, capsys):
  docs = tmp_path / 'default'
  docs.mkdir()
  monkeypatch.setattr(build, 'DOCS', str(docs))
  build.main([])
  assert capsys.readouterr().out.splitlines() == EXPECTED
  assert 'sitemap.xml' in files(docs)


def test_main_rejects_unknown_arguments(build, site, tmp_path):
  with pytest.raises(SystemExit):
    build.main(['--nope'])


def test_script_entry_point(tmp_path, monkeypatch, capsys):
  docs = tmp_path / 'out'
  monkeypatch.setattr(sys, 'argv', ['build.py', '--out', str(docs)])
  runpy.run_path(str(ROOT / 'site' / 'build.py'), run_name='__main__')
  assert capsys.readouterr().out.splitlines()[-1] == BASE + 'privacy.html'
  assert (docs / 'sitemap.xml').is_file()
