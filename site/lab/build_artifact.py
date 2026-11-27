#!/usr/bin/env python3
"""Lays the lab out as one publishable artifact: python3 site/lab/build_artifact.py <out dir>.

The out dir gets index.html (the shell, without the document skeleton the host adds), one page per
concept, current.html (the live page) and assets/ with only the images those pages use.
Prints the files map to publish beside index.html.
"""
import json, re, shutil, sys
from pathlib import Path

LAB = Path(__file__).resolve().parent
DOCS = LAB.parent.parent / "docs"
SITE = "https://meridianbrowser.app/"
out = Path(sys.argv[1])
shutil.rmtree(out, ignore_errors=True)
(out / "assets").mkdir(parents=True)
used = set()


def take(m):
    used.add(m.group(1))
    return "assets/" + m.group(1)


def localize(html):
    html = re.sub(r"\.\./\.\./docs/([\w./-]+\.(?:png|jpe?g|webp|gif|svg|html))", take, html)
    # A page that joins a folder and a file name in script: the folder moves, the files it names must be used elsewhere.
    return html.replace("../../docs/", "assets/")


shell = (LAB / "index.html").read_text()
# The host wraps the page in its own doctype, head and body.
shell = re.sub(r"<!doctype html>\n|</?(?:html|head|body)[^>]*>\n|<meta (?:charset|name=\"viewport\")[^>]*>\n|<link rel=\"icon\"[^>]*>\n", "", shell)
shell = shell.replace("'../../docs/index.html'", "'current.html'")
(out / "index.html").write_text(localize(shell))

for page in sorted(LAB.glob("0*.html")):
    (out / page.name).write_text(localize(page.read_text()))

# the lab's own pictures keep their path
if (LAB / "img").is_dir():
    shutil.copytree(LAB / "img", out / "img")

current = (DOCS / "index.html").read_text()
current = re.sub(r"<script data-goatcounter[^>]*></script>\n?", "", current)


def absolute(m):
    attr, url = m.group(1), m.group(2)
    if re.match(r"(?:https?:|#|mailto:|data:|\$)", url):
        return m.group(0)
    if attr == "src" or url == "icon.png":
        used.add(url)
        return f'{attr}="assets/{url}"'
    return f'{attr}="{SITE}{url.removeprefix("./")}"'


current = re.sub(r'\b(href|src)="([^"]*)"', absolute, current)
(out / "current.html").write_text(current)

for rel in sorted(used):
    dest = out / "assets" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(DOCS / rel, dest)

files = {str(p.relative_to(out)): str(p) for p in sorted(out.rglob("*")) if p.is_file() and p.name != "index.html"}
print(json.dumps(files, indent=1))
