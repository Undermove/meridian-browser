# The site's sources

meridianbrowser.app is served from `docs/` (GitHub Pages). Most of its pages are built:

    python3 site/build.py

To build and preview it at http://localhost:8000/, run `yarn serve`. It doesn't rebuild on save, so run it again after a change.

- `pages/changelog.html` holds both languages (`<span lang="en">…</span><span lang="ru">…</span>`). The build makes `docs/changelog.html` (English) and `docs/ru/changelog.html` (Russian) from it, with hreflang and canonical links. `pages/index.html`, the home page, is English only; the Russian pages link to it. It also gets SoftwareApplication and FAQPage structured data from its Questions.
- `guides/<slug>.html`: English guides, each starting with a JSON comment (title, description, h1…). Each becomes `docs/<slug>/index.html` in `guide_template.html`. A Russian version in `guides/ru/<slug>.html` becomes `docs/ru/<slug>/index.html`, and the two link to each other.
- `docs/sitemap.xml` lists all of them.

Edit the files here and run the build; don't edit the built pages in `docs/`. `docs/privacy.html`, the images and `install.sh` are hand-written in `docs/`. So is `docs/demo/plain.html`: a deliberately plain page (browser-default styles, `noindex`, not in the sitemap) that the browser's "Give this site a new look" card opens. Keep it plain and keep its address.

## Tests

    yarn test:site

It runs three suites, and each fails below 100% coverage:

- `yarn test:py`: pytest for `build.py` and `lab/build_artifact.py` (`tests/site/py/`), line and branch coverage. A golden test builds into a temp folder and compares it byte for byte with `docs/`, so commit the rebuilt `docs/` with any change to `site/`.
- `yarn test:node`: `node:test` for the lab tools and the `serve`/`lab` scripts (`tests/site/node/`).
- `yarn test:web`: Playwright on the built `docs/index.html` and the lab pages (`tests/site/web/`). It covers every inline `<script>` line, using V8 coverage (`tests/site/web/coverage.mjs`). `tests/site/web/coverage-exclusions.json` lists the few lines allowed to stay missed, each with the reason. Tests never reach the network: every request off 127.0.0.1 is blocked unless a test answers it.

To check that the tests catch a change, run them against a mutant: `MUTANT='{"file":"docs/index.html","from":"a < b","to":"a <= b"}' npx playwright test <specs>`. It serves the changed page in place of the file (`from` must occur once) and never writes to disk. The raw coverage files start with the spec's name, so you can see which specs run a line.

The first run needs Playwright's Chromium (`npx playwright install chromium`) and [uv](https://docs.astral.sh/uv/).

## The design lab

`lab/` is a design lab: landing page concepts to compare, one self-contained file each, with `lab/index.html` to flip between them and the current page. Run `yarn lab` and open http://localhost:8010/site/lab/. It is not built into `docs/`. To share it, `python3 site/lab/build_artifact.py <out dir>` lays it out as one artifact (pages plus the images they use) and prints the files to publish beside `index.html`.
