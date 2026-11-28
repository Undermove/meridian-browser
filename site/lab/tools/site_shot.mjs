// A staged Meridian window for the site's hero picture: a temp profile, made-up pages served
// from site_shot_pages.mjs, real site logos as favicons. Nothing of the owner's is touched.
// Usage: MERIDIAN_APP=<binary> node site_shot.mjs <out.png> <icons dir>
import { BRANDS, createServer } from './site_shot_pages.mjs';

// Imported only by cli(): importing it strips the environment, hooks node:test and cleans temp
// folders, which a unit test must not do.
export const HARNESS = new URL('../../../chromium/tests/harness.mjs', import.meta.url);
export const USAGE = 'Usage: MERIDIAN_APP=<binary> node site_shot.mjs <out.png> <icons dir>';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (h) => `http://${h}.example/`;
export const URLS = ['fieldnotes', 'coastline', 'recipes', ...BRANDS].map(url);

const T = 'app.$.tabstrip';

// Arranges the sidebar through the harness browser `b` and takes the shot.
export async function stage(b, { SB, out, split = true, wait = sleep, log = console.log }) {
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
    await wait(300);
  }
  const folder = await b.eval(`${T}.handler_.addFolder({container: ${JSON.stringify(space)}, parentId: '', index: -1}, 'Work')`);
  const fid = JSON.stringify(folder.itemId ?? folder);
  for (const n of ['GitHub', 'Telegram']) {
    await b.eval(`${T}.handler_.pinTab(${await id(n)}, {container: ${JSON.stringify(space)}, parentId: ${fid}, index: -1}, '')`);
    await wait(300);
  }
  await b.eval(`${T}.handler_.pinTab(${await id('YouTube')}, {container: ${JSON.stringify(space)}, parentId: '', index: -1}, '')`);
  await wait(500);
  log('tabs', JSON.stringify((await b.tabs()).map((t) => [t.title, t.active])));
  // Field Notes active, Coastline beside it
  await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('Field Notes'))`);
  await wait(600);
  if (split) {
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('Coastline'))`, 'Open in Split View');
    await b.waitFor(`app.$.contentRegion.hasAttribute('split')`);
  }
  await wait(2500);
  log('state', JSON.stringify(await b.state()));
  log('pinned', JSON.stringify(await b.pinned()), 'favs', JSON.stringify(await b.favorites()));
  await b.screenshot(out);
}

export async function main([out, icons], { launch, SB, env = process.env, wait, log }) {
  const server = createServer(icons);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const b = await launch(URLS, {
      args: [`--host-resolver-rules=MAP *.example 127.0.0.1:${port}`, '--window-size=1500,960', '--force-device-scale-factor=2'],
    });
    try {
      await stage(b, { SB, out, split: !env.NO_SPLIT, wait, log });
    } finally {
      await b.close();
    }
  } finally {
    server.close();
  }
}

export async function cli(argv, { harness = HARNESS, ...opts } = {}) {
  if (argv.length < 2) {
    console.error(USAGE);
    return 2;
  }
  const { launch, SB } = await import(harness);
  await main(argv, { launch, SB, ...opts });
  return 0;
}

if (import.meta.main) process.exitCode = await cli(process.argv.slice(2));
