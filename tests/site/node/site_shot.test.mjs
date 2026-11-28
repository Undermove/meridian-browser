// The hero shot's driver: what it asks the browser to do, in order, through a fake harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESS, URLS, cli, main, sleep, stage } from '../../../site/lab/tools/site_shot.mjs';
import { fakeBrowser } from './fixtures/fake_browser.mjs';

const SB = 'app.$.tabstrip.shadowRoot';
const T = 'app.$.tabstrip';
const SCRIPT = fileURLToPath(new URL('../../../site/lab/tools/site_shot.mjs', import.meta.url));
const ICONS = fileURLToPath(new URL('../../../site/lab/tools/', import.meta.url));
const rows = `[...${SB}.querySelectorAll('meridian-tab-row')]`;
const fav = (id) => `${T}.handler_.pinTab("${id}", {container: 'favorites', parentId: '', index: -1}, '')`;
const inFolder = (id) => `${T}.handler_.pinTab("${id}", {container: "space-1", parentId: "folder-1", index: -1}, '')`;

// The original script's calls, string for string.
const expected = ({ split, out }) => [
  ['waitFor', `${SB}.querySelectorAll('meridian-tab-row').length === 10`, 30000],
  ['waitFor', `[...${SB}.querySelectorAll('meridian-tab-row')].every((r) => !r.tab.url.startsWith('about:'))`, 20000],
  ['eval', `${T}.state_.activeSpaceId`],
  ['eval', `${T}.handler_.updateSpace("space-1", 'Personal', '', '#6F7BFF', '#FF8FBC')`],
  ['eval', `${T}.handler_.createSpace('Work', '', '#19C7A8', '#C9F02E')`],
  ['eval', `${T}.handler_.activateSpace("space-1")`],
  ['tabs'], ['eval', fav('tab-3')], ['sleep', 300],
  ['tabs'], ['eval', fav('tab-4')], ['sleep', 300],
  ['tabs'], ['eval', fav('tab-5')], ['sleep', 300],
  ['tabs'], ['eval', fav('tab-6')], ['sleep', 300],
  ['eval', `${T}.handler_.addFolder({container: "space-1", parentId: '', index: -1}, 'Work')`],
  ['tabs'], ['eval', inFolder('tab-7')], ['sleep', 300],
  ['tabs'], ['eval', inFolder('tab-8')], ['sleep', 300],
  ['tabs'], ['eval', `${T}.handler_.pinTab("tab-9", {container: "space-1", parentId: '', index: -1}, '')`], ['sleep', 500],
  ['tabs'],
  ['click', `${rows}.find((r) => r.tab.title.startsWith('Field Notes'))`], ['sleep', 600],
  ...(split ? [
    ['menu', `${rows}.find((r) => r.tab.title.startsWith('Coastline'))`, 'Open in Split View'],
    ['waitFor', `app.$.contentRegion.hasAttribute('split')`, undefined],
  ] : []),
  ['sleep', 2500],
  ['state'], ['pinned'], ['favorites'],
  ['screenshot', out],
];

function run(b, opts) {
  const logs = [];
  const wait = async (ms) => { b.calls.push(['sleep', ms]); };
  return stage(b, { SB, wait, log: (...a) => logs.push(a.join(' ')), ...opts }).then(() => logs);
}

test('stage: favorites, the Work folder, YouTube pinned, split view, then the shot', async () => {
  const b = fakeBrowser();
  const logs = await run(b, { out: '/tmp/x/hero.png', split: true });
  assert.deepEqual(b.calls, expected({ split: true, out: '/tmp/x/hero.png' }));
  assert.match(logs[0], /^tabs \[\["Field Notes: Slow mornings",true\],/);
  assert.equal(logs[1], 'state {"active":0}');
  assert.equal(logs[2], 'pinned ["GitHub"] favs ["Linear"]');
});

test('stage: no split view when split is off', async () => {
  const b = fakeBrowser();
  await run(b, { out: 'a.png', split: false });
  assert.deepEqual(b.calls, expected({ split: false, out: 'a.png' }));
  assert.ok(!b.calls.some(([name]) => name === 'menu'));
});

test('stage: addFolder may answer with the bare id', async () => {
  const b = fakeBrowser({ folder: 'folder-1' });
  await run(b, { out: 'a.png', split: true });
  assert.deepEqual(b.calls, expected({ split: true, out: 'a.png' }));
});

test('sleep waits about as long as asked', async () => {
  const t0 = performance.now();
  await sleep(30);
  assert.ok(performance.now() - t0 >= 25);
});

test('the harness path points at chromium/tests/harness.mjs (not imported here)', () => {
  assert.ok(HARNESS.href.endsWith('/chromium/tests/harness.mjs'));
  assert.ok(fs.existsSync(fileURLToPath(HARNESS)));
  assert.doesNotMatch(fs.readFileSync(SCRIPT, 'utf8'), /\/Users\//);
});

test('URLS: the three own pages, then the brands, as .example hosts', () => {
  assert.deepEqual(URLS, ['fieldnotes', 'coastline', 'recipes', 'linear', 'notion', 'spotify', 'figma', 'github', 'telegram', 'youtube']
    .map((h) => `http://${h}.example/`));
});

const viaHost = (port, host, path = '/') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ type: res.headers['content-type'], body }));
  }).on('error', reject);
});
const refused = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});

function fakeLaunch(seen, opts) {
  return async (urls, launchOpts) => {
    const port = Number(launchOpts.args[0].match(/^--host-resolver-rules=MAP \*\.example 127\.0\.0\.1:(\d+)$/)[1]);
    seen.urls = urls;
    seen.args = launchOpts.args;
    seen.port = port;
    seen.page = await viaHost(port, 'linear.example');
    seen.icon = await viaHost(port, 'linear.example', '/favicon.svg');
    seen.b = fakeBrowser(opts);
    return seen.b;
  };
}
const quiet = { wait: async () => {}, log: () => {} };

test('main: serves the pages to the launched browser, stages, shoots, closes everything', async () => {
  const seen = {};
  await main(['/tmp/out.png', ICONS], { launch: fakeLaunch(seen), SB, env: {}, ...quiet });
  assert.deepEqual(seen.urls, URLS);
  assert.deepEqual(seen.args.slice(1), ['--window-size=1500,960', '--force-device-scale-factor=2']);
  assert.match(seen.page.body, /<title>Linear<\/title>/);
  assert.equal(seen.icon.type, 'image/svg+xml');
  assert.ok(seen.b.calls.some(([n, e]) => n === 'menu' && e.includes('Coastline')));
  assert.deepEqual(seen.b.calls.at(-2), ['screenshot', '/tmp/out.png']);
  assert.deepEqual(seen.b.calls.at(-1), ['close']);
  assert.ok(await refused(seen.port), 'the page server is closed');
});

test('main: NO_SPLIT in the environment leaves split view out', async () => {
  const seen = {};
  await main(['o.png', ICONS], { launch: fakeLaunch(seen), SB, env: { NO_SPLIT: '1' }, ...quiet });
  assert.ok(!seen.b.calls.some(([n]) => n === 'menu'));
});

test('main: a failed step still closes the browser and the server', async () => {
  const seen = {};
  const failOn = (name) => name === 'waitFor';
  await assert.rejects(main(['o.png', ICONS], { launch: fakeLaunch(seen, { failOn }), SB, env: {}, ...quiet }), /fake waitFor failed/);
  assert.deepEqual(seen.b.calls.at(-1), ['close']);
  assert.ok(await refused(seen.port));
});

test('main: a browser that fails to start still closes the server', async () => {
  let port;
  const launch = async (urls, { args }) => {
    port = Number(args[0].split(':').pop());
    throw new Error('no browser');
  };
  await assert.rejects(main(['o.png', ICONS], { launch, SB, env: {}, ...quiet }), /no browser/);
  assert.ok(await refused(port));
});

test('cli: no arguments prints usage and does not load the harness', async (t) => {
  const err = t.mock.method(console, 'error', () => {});
  assert.equal(await cli([], { harness: new URL('file:///nonexistent/harness.mjs') }), 2);
  assert.match(err.mock.calls[0].arguments[0], /^Usage: MERIDIAN_APP=<binary> node site_shot\.mjs <out\.png> <icons dir>/);
  assert.equal(await cli(['only-out.png'], { harness: new URL('file:///nonexistent/harness.mjs') }), 2);
});

test('cli: loads the harness and runs main with it', async () => {
  const fake = new URL('./fixtures/fake_harness.mjs', import.meta.url);
  const { launches } = await import(fake);
  assert.equal(await cli(['shot.png', ICONS], { harness: fake, env: { NO_SPLIT: '' }, ...quiet }), 0);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].urls, URLS);
  assert.equal(launches[0].b.calls[0][1], `FAKE_SB.querySelectorAll('meridian-tab-row').length === 10`);
  assert.deepEqual(launches[0].b.calls.at(-2), ['screenshot', 'shot.png']);
});

test('run as a script without arguments: usage on stderr, exit 2', async () => {
  // The parent's env carries NODE_V8_COVERAGE, so the child's run counts toward coverage.
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { ...process.env } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Usage: /);
  assert.equal(r.stdout, '');
});
