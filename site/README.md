# The site's sources

meridianbrowser.app is served from `docs/` (GitHub Pages). Most of its pages are built:

    python3 site/build.py

- `pages/index.html` and `pages/changelog.html` hold both languages (`<span lang="en">…</span><span lang="ru">…</span>`). The build makes `docs/<page>.html` (English) and `docs/ru/<page>.html` (Russian) from each, with hreflang and canonical links. The home page also gets SoftwareApplication and FAQPage structured data from its Questions.
- `guides/<slug>.html`: English guides, each starting with a JSON comment (title, description, h1…). Each becomes `docs/<slug>/index.html` in `guide_template.html`. A Russian version in `guides/ru/<slug>.html` becomes `docs/ru/<slug>/index.html`, and the two link to each other.
- `docs/sitemap.xml` lists all of them.

Edit the files here and run the build; don't edit the built pages in `docs/`. `docs/privacy.html`, the images and `install.sh` are hand-written in `docs/`.
