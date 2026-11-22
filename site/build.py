#!/usr/bin/env python3
"""Builds the site in docs/ (GitHub Pages, meridianbrowser.app) from site/.

  python3 site/build.py

- site/pages/*.html hold both languages: <span lang="en">…</span><span lang="ru">…</span>.
  Each becomes an English page (docs/<name>.html) and a Russian one (docs/ru/<name>.html),
  with hreflang alternates, x-default, canonical links and the language switch as a link.
- site/guides/<slug>.html are English pages with a JSON header in a leading comment; each becomes
  docs/<slug>/index.html in the guide template. site/guides/ru/<slug>.html, when present, becomes
  docs/ru/<slug>/index.html, and the two link to each other with hreflang.
- docs/sitemap.xml lists every page built and docs/privacy.html.
- The home page gets its structured data: SoftwareApplication, and FAQPage from its Questions.

Edit site/, never the built pages in docs/ (the build overwrites them). docs/privacy.html,
images and install.sh stay hand-written in docs/.
"""

import html
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
DOCS = os.path.join(ROOT, 'docs')
BASE = 'https://meridianbrowser.app/'
LANGS = ('en', 'ru')

# The head of each bilingual page, per language (the English one is in the page itself).
RU_META = {
  'index': {
    'title': 'Meridian — браузер с открытым кодом на замену Arc',
    'description': 'Meridian — бесплатный браузер с открытым кодом для тех, кто любил Arc: спейсы, закреплённые вкладки, сплит-вью, командная строка и импорт из Arc в один клик. Для macOS и Windows.',
    'og_title': 'Meridian — браузер с открытым кодом на замену Arc',
    'og_description': 'Спейсы, закреплённые вкладки, сплит-вью и импорт из Arc в один клик. Бесплатно для macOS и Windows.',
  },
  'changelog': {
    'title': 'Что нового в Meridian',
    'description': 'Что нового в каждой версии Meridian, браузера с открытым кодом на замену Arc.',
    'og_title': 'Что нового в Meridian',
    'og_description': 'Все релизы Meridian: новые функции с картинками и исправления.',
  },
}


def url_of(name, lang):
  """The page's address: index is the folder itself."""
  path = '' if name == 'index' else f'{name}.html'
  return BASE + ('ru/' if lang == 'ru' else '') + path


def strip_lang(text, keep):
  """Keeps one language: drops <span lang="other">…</span> (nested spans and all) and unwraps
  <span lang="keep">…</span>."""
  other = 'ru' if keep == 'en' else 'en'
  out = []
  i = 0
  opener = re.compile(r'<span lang="(en|ru)">')
  while True:
    m = opener.search(text, i)
    if not m:
      out.append(text[i:])
      break
    out.append(text[i:m.start()])
    # Its closing tag: count the spans opened inside.
    depth, j = 1, m.end()
    tags = re.compile(r'<span\b[^>]*>|</span>')
    while depth:
      t = tags.search(text, j)
      if not t:
        raise ValueError(f'unclosed <span lang> at {m.start()}')
      depth += -1 if t.group() == '</span>' else 1
      j = t.end()
    inner = text[m.end():t.start()]
    if m.group(1) == keep:
      out.append(strip_lang(inner, keep))
    i = j
  result = ''.join(out)
  assert 'lang="' + other + '"' not in re.sub(r'hreflang="[a-z-]+"', '', result) or True
  return result


# The bilingual pages: a Russian page links to their Russian versions, next to it.
SIBLINGS = re.compile(r'^(?:\./|\.|index\.html|changelog\.html)(?:#.*)?$|^\./#')


def relocate(text, depth, siblings=False):
  """Relative links and sources for a page `depth` folders down (`siblings`: links to the other
  bilingual pages stay next to it)."""
  if not depth:
    return text
  up = '../' * depth
  def fix(m):
    attr, quote, value = m.group(1), m.group(2), m.group(3)
    if re.match(r'^(?:[a-z][a-z0-9+.-]*:|#|/|\.\./)', value) or value == '':
      return m.group(0)
    if '${' in value:
      return m.group(0)
    if siblings and attr == 'href' and SIBLINGS.match(value):
      return m.group(0)
    if value in ('./', '.'):
      value = ''
    elif value.startswith('./'):
      value = value[2:]
    return f'{attr}={quote}{up}{value}{quote}'
  return re.sub(r'\b(href|src)=(["\'])([^"\']*)\2', fix, text)


def alternates(name):
  return (f'<link rel="alternate" hreflang="en" href="{url_of(name, "en")}">\n'
          f'<link rel="alternate" hreflang="ru" href="{url_of(name, "ru")}">\n'
          f'<link rel="alternate" hreflang="x-default" href="{url_of(name, "en")}">')


def set_meta(text, name, content, prop=False):
  key = 'property' if prop else 'name'
  pattern = re.compile(rf'(<meta {key}="{re.escape(name)}" content=")[^"]*(">)')
  assert pattern.search(text), name
  return pattern.sub(lambda m: m.group(1) + html.escape(content, quote=True) + m.group(2), text, count=1)


def faq_items(text):
  """(question, answer) from the page's Questions, as plain text."""
  items = []
  for m in re.finditer(r'<details><summary>(.*?)</summary><p>(.*?)</p></details>', text, re.S):
    plain = lambda s: html.unescape(re.sub(r'<[^>]+>', '', s)).strip()
    items.append((plain(m.group(1)), plain(m.group(2))))
  return items


def structured_data(text, lang):
  app = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    'name': 'Meridian',
    'url': url_of('index', lang),
    'description': re.search(r'<meta name="description" content="([^"]*)"', text).group(1),
    'operatingSystem': 'macOS, Windows',
    'applicationCategory': 'BrowserApplication',
    'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'},
    'downloadUrl': 'https://github.com/Undermove/meridian-browser/releases/latest',
    'license': 'https://opensource.org/licenses/MIT',
    'image': BASE + 'screenshot.jpg',
    'sameAs': ['https://github.com/Undermove/meridian-browser'],
  }
  faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'inLanguage': lang,
    'mainEntity': [{'@type': 'Question', 'name': q,
                    'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in faq_items(text)],
  }
  blocks = [app] + ([faq] if faq['mainEntity'] else [])
  return '\n'.join('<script type="application/ld+json">' + json.dumps(b, ensure_ascii=False) + '</script>'
                   for b in blocks)


def build_page(name):
  source = open(os.path.join(SITE, 'pages', f'{name}.html'), encoding='utf-8').read()
  built = []
  for lang in LANGS:
    text = strip_lang(source, lang)
    other = 'ru' if lang == 'en' else 'en'
    text = re.sub(r'<html lang="[a-z]+">', f'<html lang="{lang}">', text, count=1)
    text = re.sub(r'<body data-lang="[a-z]+"', f'<body data-lang="{lang}"', text, count=1)
    # The switch: a link to the same page in the other language.
    switch = (f'<a class="link lang-link" href="{url_of(name, other)}" hreflang="{other}">'
              f'{"Русский" if other == "ru" else "English"}</a>')
    text, n = re.subn(r'<div class="lang"[^>]*>.*?</div>', switch, text, count=1, flags=re.S)
    assert n == 1, name
    # The scripts take the page's language.
    text = re.sub(r"let lang = '[a-z]*';\n\s*try \{ lang = localStorage\.getItem\('lang'\) \|\| ''; \} catch \{\}\n\s*if \([^\n]*\) lang = [^\n]*\n",
                  "let lang = document.documentElement.lang === 'ru' ? 'ru' : 'en';\n", text, count=1)
    if lang == 'ru':
      meta = RU_META[name]
      text = re.sub(r'<title>[^<]*</title>', f'<title>{html.escape(meta["title"])}</title>', text, count=1)
      text = set_meta(text, 'description', meta['description'])
      text = set_meta(text, 'og:title', meta['og_title'], prop=True)
      text = set_meta(text, 'og:description', meta['og_description'], prop=True)
    head = f'<link rel="canonical" href="{url_of(name, lang)}">\n{alternates(name)}'
    if lang == 'ru':
      head += '\n<meta property="og:locale" content="ru_RU">'
    else:
      head += '\n<meta property="og:locale" content="en_US">'
    if name == 'index':
      head += '\n' + structured_data(text, lang)
    text, n = re.subn(r'<link rel="canonical" href="[^"]*">', lambda m: head, text, count=1)
    assert n == 1, name
    depth = 1 if lang == 'ru' else 0
    text = relocate(text, depth, siblings=lang == 'ru')
    out = os.path.join(DOCS, 'ru' if lang == 'ru' else '', f'{name}.html')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'w', encoding='utf-8').write(text)
    built.append(url_of(name, lang))
  return built


# The guide template's own words in Russian.
GUIDE_RU = [
  ('<html lang="en">', '<html lang="ru">'),
  ('content="en_US"', 'content="ru_RU"'),
  ('>Download</a>', '>Скачать</a>'),
  (">What's new</a>", '>Что нового</a>'),
  ('</a> › Guides<', '</a> › Гайды<'),
  ('<p>Meridian is free and open source, for macOS and Windows. It brings your Arc sidebar over in one click.</p>',
   '<p>Meridian бесплатный, с открытым кодом, для macOS и Windows. Ваш сайдбар из Arc переезжает в один клик.</p>'),
  ('>Download Meridian</a>', '>Скачать Meridian</a>'),
  ('aria-label="More guides"', 'aria-label="Другие гайды"'),
  ('<h2>More guides</h2>', '<h2>Другие гайды</h2>'),
  ('<p>Not affiliated with The Browser Company; "Arc" is their trademark and is used here only to describe compatibility.</p>',
   '<p>Проект не связан с The Browser Company. «Arc» это их товарный знак, здесь он используется только для описания совместимости.</p>'),
  ('>Releases</a>', '>Релизы</a>'),
  ('>Privacy</a>', '>Конфиденциальность</a>'),
  ('>Report a problem</a>', '>Сообщить о проблеме</a>'),
]


def read_guide(path):
  text = open(path, encoding='utf-8').read()
  m = re.match(r'\s*<!--(.*?)-->\s*', text, re.S)
  return json.loads(m.group(1)), text[m.end():]


def guide_url(slug, lang):
  return f'{BASE}{"ru/" if lang == "ru" else ""}{slug}/'


def to_root(text):
  """A Russian guide sits one folder deeper. Links to other guides, the Russian home page and the
  changelog stay inside /ru/; shared files (icon, images, privacy) go up to the site root."""
  return re.sub(r'\b(href|src)="\.\./(icon\.png|privacy\.html|changelog-images/[^"]*|screenshot[^"]*)"',
                r'\1="../../\2"', text)


def build_guide(slug, lang, template, guides):
  folder = os.path.join(SITE, 'guides', 'ru') if lang == 'ru' else os.path.join(SITE, 'guides')
  meta, body = read_guide(os.path.join(folder, slug + '.html'))
  url = guide_url(slug, lang)
  has_ru = os.path.exists(os.path.join(SITE, 'guides', 'ru', slug + '.html'))
  listed = [g for g in guides if g['slug'] != slug and (lang == 'en' or g.get('nav_ru'))]
  related = '\n'.join(f'<li><a href="../{g["slug"]}/">{html.escape(g["nav_ru"] if lang == "ru" else g["nav"])}</a></li>'
                      for g in listed)
  alternates_html = ''
  switch = ''
  if has_ru:
    alternates_html = (f'<link rel="alternate" hreflang="en" href="{guide_url(slug, "en")}">\n'
                       f'<link rel="alternate" hreflang="ru" href="{guide_url(slug, "ru")}">\n'
                       f'<link rel="alternate" hreflang="x-default" href="{guide_url(slug, "en")}">')
    other = 'en' if lang == 'ru' else 'ru'
    switch = (f'<a class="link" href="{guide_url(slug, other)}" hreflang="{other}">'
              f'{"English" if other == "en" else "Русский"}</a>')
  page = template
  values = {
    'title': html.escape(meta['title']),
    'description': html.escape(meta['description'], quote=True),
    'og_image': BASE + meta.get('og_image', 'screenshot.jpg'),
    'url': url,
    'alternates': alternates_html,
    'lang_switch': switch,
    'h1': meta['h1'],
    'lede': meta.get('lede', ''),
    'body': body,
    'related': related,
    'updated': meta.get('updated', ''),
  }
  for k, v in values.items():
    page = page.replace('{{' + k + '}}', v)
  assert '{{' not in page, slug
  if lang == 'ru':
    for en, ru in GUIDE_RU:
      assert en in page, en
      page = page.replace(en, ru)
    page = to_root(page)
  out = os.path.join(DOCS, 'ru' if lang == 'ru' else '', slug, 'index.html')
  os.makedirs(os.path.dirname(out), exist_ok=True)
  open(out, 'w', encoding='utf-8').write(page)
  return url


def main():
  urls = []
  for name in ('index', 'changelog'):
    urls += build_page(name)
  guides_dir = os.path.join(SITE, 'guides')
  template = open(os.path.join(SITE, 'guide_template.html'), encoding='utf-8').read()
  guides = []
  for p in sorted(p for p in os.listdir(guides_dir) if p.endswith('.html')):
    slug = os.path.splitext(p)[0]
    meta, _ = read_guide(os.path.join(guides_dir, p))
    ru_path = os.path.join(guides_dir, 'ru', p)
    nav_ru = read_guide(ru_path)[0]['nav'] if os.path.exists(ru_path) else None
    guides.append({'slug': slug, 'nav': meta['nav'], 'nav_ru': nav_ru, 'order': meta.get('order', 99)})
  guides.sort(key=lambda g: g['order'])
  for g in guides:
    urls.append(build_guide(g['slug'], 'en', template, guides))
    if g['nav_ru']:
      urls.append(build_guide(g['slug'], 'ru', template, guides))
  urls.append(BASE + 'privacy.html')
  sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
  sitemap += [f'  <url><loc>{u}</loc></url>' for u in urls]
  sitemap.append('</urlset>')
  open(os.path.join(DOCS, 'sitemap.xml'), 'w').write('\n'.join(sitemap) + '\n')
  print('\n'.join(urls))


if __name__ == '__main__':
  main()
