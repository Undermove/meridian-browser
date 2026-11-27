// A staged Meridian window for the site's hero picture: a temp profile, made-up pages served
// from this script, real site logos as favicons. Nothing of the owner's is touched.
// Usage: MERIDIAN_APP=<binary> node site_shot.mjs <out.png> <icons dir>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, SB } from '/Users/jackuait/meridian-browser/chromium/tests/harness.mjs';

const [out, icons] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (f, fill) => {
  let s = fs.readFileSync(path.join(icons, f), 'utf8').replace(/<\?xml[^>]*>/, '');
  if (fill) s = s.replace('<svg ', `<svg fill="#${fill}" `);
  return s;
};
// Sites that are only a row in the sidebar: a title and the real logo as the favicon.
const BRANDS = {
  linear: ['Linear', svg('linear.svg', '5E6AD2')], notion: ['Notion', svg('notion.svg', '000000')],
  spotify: ['Spotify', svg('spotify.svg', '1ED760')], figma: ['Figma', svg('gb-figma.svg')],
  github: ['GitHub', svg('github.svg', '181717')], telegram: ['Telegram', svg('telegram.svg', '26A5E4')],
  youtube: ['YouTube', svg('youtube.svg', 'FF0000')],
};
const FAV = (color, d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${color}"/>${d}</svg>`;
const OWN = {
  fieldnotes: FAV('#FF5B1F', '<circle cx="12" cy="13" r="5" fill="#FFF3E2"/>'),
  coastline: FAV('#0E8A7A', '<path d="M4 15c3-4 5 3 8-1s5 3 8-1" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'),
  recipes: FAV('#C9F02E', '<path d="M7 7v10M11 7v4a2 2 0 0 1-4 0M16 7c-2 2-2 5 0 6v4" fill="none" stroke="#0E3A24" stroke-width="2" stroke-linecap="round"/>'),
};

const FIELD = `<!doctype html><meta charset="utf-8"><title>Field Notes: Slow mornings</title><link rel="icon" href="/favicon.svg">
<style>
*{box-sizing:border-box}body{margin:0;background:#FFFCF6;color:#1B120D;font:17px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
nav{display:flex;align-items:center;gap:22px;padding:18px 34px;font-size:14px;color:#6b5f57}
nav b{display:flex;align-items:center;gap:10px;margin-right:auto;font-size:17px;color:#1B120D}
nav i{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#FF5B1F,#FF2E63)}
.art{position:relative;margin:4px 26px 0;height:330px;border-radius:28px;overflow:hidden;background:linear-gradient(180deg,#2038FF 0%,#7A5CFF 38%,#FF5FA2 66%,#FFB03A 100%)}
.sun{position:absolute;left:50%;bottom:-150px;width:420px;height:420px;margin-left:-210px;border-radius:50%;background:radial-gradient(circle at 50% 35%,#FFF6C9,#FFD41F 45%,#FF7A1F);box-shadow:0 0 120px 40px rgba(255,212,31,.55)}
.hill{position:absolute;bottom:-60px;height:170px;border-radius:50%}
.h1{left:-12%;width:70%;background:#1A1FA8}.h2{right:-18%;width:80%;height:150px;background:#101466}
.art span{position:absolute;left:26px;top:22px;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#FFF3E2}
main{max-width:560px;margin:0 auto;padding:34px 34px 60px}
.k{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:#E0431A}
h1{margin:12px 0 10px;font:700 50px/1.02 ui-serif,"New York",Georgia,serif;letter-spacing:-.02em}
.m{font-size:14px;color:#8a7d74;margin-bottom:22px}
p{margin:0 0 16px}
</style>
<nav><b><i></i>Field Notes</b><span>Essays</span><span>Travel</span><span>About</span></nav>
<div class="art"><span>No. 12 · Morning</span><div class="sun"></div><div class="hill h1"></div><div class="hill h2"></div></div>
<main><div class="k">Essay</div><h1>The quiet art of slow mornings</h1><div class="m">8 min read · October 2026</div>
<p>There is a particular kind of light that only exists between six and seven. It arrives sideways, warm and unhurried, and it asks nothing of you. For years I slept through it.</p>
<p>Then I started keeping a small ritual: water on, window open, one page of something I actually wanted to read. No inbox, no feeds, no tabs I'd promised myself to get back to.</p></main>`;

const COAST = `<!doctype html><meta charset="utf-8"><title>Coastline: North by night train</title><link rel="icon" href="/favicon.svg">
<style>
*{box-sizing:border-box}body{margin:0;background:#06231F;color:#E9FFF6;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
header{padding:20px 30px;display:flex;align-items:center;gap:10px;font-weight:700}
header i{width:24px;height:24px;border-radius:7px;background:#19C7A8}
header span{margin-left:auto;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#7DFFE2}
h1{margin:14px 30px 6px;font:800 54px/.95 -apple-system,sans-serif;letter-spacing:-.03em}
h1 em{font-style:normal;color:#C9F02E}
.sub{margin:0 30px 22px;color:#9CCFC2}
.map{position:relative;margin:0 22px;height:300px;border-radius:26px;overflow:hidden;background:radial-gradient(120% 90% at 0% 0%,#19C7A8,transparent 60%),radial-gradient(90% 90% at 100% 100%,#2038FF,transparent 65%),#0B4A44}
.map svg{position:absolute;inset:0;width:100%;height:100%}
ul{list-style:none;margin:20px 30px;padding:0;display:grid;gap:10px}
li{display:flex;align-items:center;gap:14px;padding:13px 16px;border-radius:16px;background:rgba(255,255,255,.07);font-weight:600}
li b{font:600 13px/1 ui-monospace,Menlo,monospace;color:#C9F02E;width:52px}
li span{margin-left:auto;font-size:13px;font-weight:500;color:#9CCFC2}
</style>
<header><i></i>Coastline<span>Trip 04</span></header>
<h1>North by <em>night train</em></h1><p class="sub">Three stops, two nights, one very good station café.</p>
<div class="map"><svg viewBox="0 0 600 300" preserveAspectRatio="none"><path d="M-20 250C80 240 110 150 200 160s110 70 190 20S500 60 620 50" fill="none" stroke="#E9FFF6" stroke-width="5" stroke-dasharray="2 14" stroke-linecap="round"/><g fill="#C9F02E" stroke="#06231F" stroke-width="5"><circle cx="70" cy="237" r="13"/><circle cx="230" cy="166" r="13"/><circle cx="410" cy="170" r="13"/><circle cx="560" cy="62" r="13"/></g></svg></div>
<ul><li><b>21:40</b>Harbour Central<span>Platform 4</span></li><li><b>06:15</b>Lake Halt<span>Breakfast from six</span></li><li><b>19:05</b>North Point<span>End of the line</span></li></ul>`;

const RECIPES = `<!doctype html><meta charset="utf-8"><title>Weekend Recipes</title><link rel="icon" href="/favicon.svg"><body style="font:16px -apple-system;padding:40px"><h1>Weekend Recipes</h1>`;

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split('.')[0];
  const icon = req.url.startsWith('/favicon.svg');
  if (icon) res.setHeader('content-type', 'image/svg+xml'); else res.setHeader('content-type', 'text/html; charset=utf-8');
  if (BRANDS[host]) return res.end(icon ? BRANDS[host][1] : `<!doctype html><meta charset="utf-8"><title>${BRANDS[host][0]}</title><link rel="icon" href="/favicon.svg"><body style="font:16px -apple-system;padding:40px"><h1>${BRANDS[host][0]}</h1>`);
  if (icon) return res.end(OWN[host] || OWN.fieldnotes);
  res.end(host === 'coastline' ? COAST : host === 'recipes' ? RECIPES : FIELD);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = (h) => `http://${h}.example/`;

const T = 'app.$.tabstrip';
const b = await launch(['fieldnotes', 'coastline', 'recipes', ...Object.keys(BRANDS)].map(url), {
  args: [`--host-resolver-rules=MAP *.example 127.0.0.1:${port}`, '--window-size=1500,960', '--force-device-scale-factor=2'],
});
try {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 10`, 30000);
  // every tab loaded once, so its title and favicon are there
  await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].every((r) => !r.tab.url.startsWith('about:'))`, 20000);
  const space = await b.eval(`${T}.state_.activeSpaceId`);
  await b.eval(`${T}.handler_.updateSpace(${JSON.stringify(space)}, 'Personal', '', '#6F7BFF', '#FF8FBC')`);
  await b.eval(`${T}.handler_.createSpace('Work', '', '#19C7A8', '#C9F02E')`);
  await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(space)})`);
  const id = async (title) => JSON.stringify((await b.tabs()).find((t) => t.title.startsWith(title)).id);
  for (const n of ['Linear', 'Notion', 'Spotify', 'Figma']) {
    await b.eval(`${T}.handler_.pinTab(${await id(n)}, {container: 'favorites', parentId: '', index: -1}, '')`);
    await sleep(300);
  }
  const folder = await b.eval(`${T}.handler_.addFolder({container: ${JSON.stringify(space)}, parentId: '', index: -1}, 'Work')`);
  const fid = JSON.stringify(folder.itemId ?? folder);
  for (const n of ['GitHub', 'Telegram']) {
    await b.eval(`${T}.handler_.pinTab(${await id(n)}, {container: ${JSON.stringify(space)}, parentId: ${fid}, index: -1}, '')`);
    await sleep(300);
  }
  await b.eval(`${T}.handler_.pinTab(${await id('YouTube')}, {container: ${JSON.stringify(space)}, parentId: '', index: -1}, '')`);
  await sleep(500);
  console.log('tabs', JSON.stringify((await b.tabs()).map((t) => [t.title, t.active])));
  // Field Notes active, Coastline beside it
  await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('Field Notes'))`);
  await sleep(600);
  if (!process.env.NO_SPLIT) {
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('Coastline'))`, 'Open in Split View');
    await b.waitFor(`app.$.contentRegion.hasAttribute('split')`);
  }
  await sleep(2500);
  console.log('state', JSON.stringify(await b.state()));
  console.log('pinned', JSON.stringify(await b.pinned()), 'favs', JSON.stringify(await b.favorites()));
  await b.screenshot(out);
} finally {
  await b.close();
  server.close();
}
