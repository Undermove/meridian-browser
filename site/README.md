# The site's sources

meridianbrowser.app is served from `docs/` (GitHub Pages). Most of its pages are built:

    python3 site/build.py

To build and preview it at http://localhost:8000/, run `yarn serve`. It doesn't rebuild on save, so run it again after a change.

- `pages/changelog.html` holds both languages (`<span lang="en">…</span><span lang="ru">…</span>`). The build makes `docs/changelog.html` (English) and `docs/ru/changelog.html` (Russian) from it, with hreflang and canonical links. `pages/index.html`, the home page, is English only; the Russian pages link to it. It also gets SoftwareApplication and FAQPage structured data from its Questions.
- `guides/<slug>.html`: English guides, each starting with a JSON comment (title, description, h1…). Each becomes `docs/<slug>/index.html` in `guide_template.html`. A Russian version in `guides/ru/<slug>.html` becomes `docs/ru/<slug>/index.html`, and the two link to each other.
- `docs/sitemap.xml` lists all of them.

Edit the files here and run the build; don't edit the built pages in `docs/`. `docs/privacy.html`, the images and `install.sh` are hand-written in `docs/`. So is `docs/demo/plain.html`: a deliberately plain page (browser-default styles, `noindex`, not in the sitemap) that the browser's "Give this site a new look" card opens. Keep it plain and keep its address.

`lab/` is a design lab: landing page concepts to compare, one self-contained file each, with `lab/index.html` to flip between them and the current page. Run `yarn lab` and open http://localhost:8010/site/lab/. It is not built into `docs/`. To share it, `python3 site/lab/build_artifact.py <out dir>` lays it out as one artifact (pages plus the images they use) and prints the files to publish beside `index.html`.
