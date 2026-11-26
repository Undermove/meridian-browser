// upload_file over MCP: a local file goes into the page's <input type=file> only after the native
// confirm (answered by a test switch); relative paths, key files and Meridian's own profile are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { launch, APP, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bridge(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = (await request('tools/call', { name, arguments: args })).result;
    const c = r.content[0];
    return r.isError ? { error: c.text } : { value: JSON.parse(c.text) };
  };
  return { request, call, close: () => proc.kill() };
}

test('upload_file: a confirmed file lands in the file field; key files are refused', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Post</title><label>Photo <input type=file id=f onchange="document.title = 'Got ' + this.files[0].name + ' ' + this.files[0].size"></label>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  const files = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-upload-')));
  const photo = path.join(files, 'photo.png');
  fs.writeFileSync(photo, Buffer.alloc(1234, 7));
  fs.writeFileSync(path.join(files, '.env'), 'KEY=1\n');
  const b = await launch([url], { profile, args: ['--meridian-test-dialog-answer=Upload this file'] });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.ok((await mcp.request('tools/list')).result.tools.some((t) => t.name === 'upload_file'));
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Post')`);

    const done = await mcp.call('upload_file', { path: photo });
    assert.deepEqual(done.value, { uploaded: 'photo.png', size: '1 KB', into: 'Photo' });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Got photo.png 1234')`);

    assert.match((await mcp.call('upload_file', { path: 'photo.png' })).error, /absolute path/);
    assert.match((await mcp.call('upload_file', { path: path.join(files, '.env') })).error, /keys or credentials/);
    assert.match((await mcp.call('upload_file', { path: path.join(profile, 'Default', 'Preferences') })).error, /keys or credentials/);
    assert.match((await mcp.call('upload_file', { path: path.join(files, 'missing.png') })).error, /no such file/);
    assert.match((await mcp.call('upload_file', { path: photo, selector: 'h1' })).error, /nothing|pick the file field/);
  } finally {
    mcp.close();
    await b.close();
    server.close();
    for (const d of [profile, files]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('upload_file: “Don’t upload” in the native confirm leaves the field empty', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Post</title><input type=file aria-label="Video" onchange="document.title = 'Got file'">`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  const files = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-upload-')));
  fs.writeFileSync(path.join(files, 'clip.mp4'), 'x');
  const b = await launch([`http://127.0.0.1:${server.address().port}/`], { profile, args: ['--meridian-test-dialog-answer=Don’t upload'] });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Post')`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.match((await mcp.call('upload_file', { path: path.join(files, 'clip.mp4') })).error, /declined/);
    await sleep(500);
    assert.ok((await b.tabs()).some((t) => t.title === 'Post'), 'nothing was put into the field');
  } finally {
    mcp.close();
    await b.close();
    server.close();
    for (const d of [profile, files]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Uploading a channel's videos is many uploads to one site: "Always on <site>" answers for good
// there, Settings > AI agents > File uploads lists it (and takes it back), and Never/Always there
// answer every upload.
test('upload_file: “Always on the site” stops the question there; Settings lists it, Never and the bin', async () => {
  const ST = 'app.$.settings.shadowRoot';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Studio</title><input type=file aria-label="Video" onchange="document.title = 'Got ' + this.files[0].name">`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  const files = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-upload-')));
  for (const n of ['one.mp4', 'two.mp4', 'three.mp4', 'four.mp4']) fs.writeFileSync(path.join(files, n), n);
  const start = async (answer) => {
    const b = await launch([url], { profile, args: [`--meridian-test-dialog-answer=${answer}`] });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Studio')`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    const mcp = bridge(profile);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    return { b, mcp };
  };
  const openAgents = async (b) => {
    await b.eval(`app.$.tabstrip.runCommand(13, 0)`);
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'ai')`);
    await b.waitFor(`!!${ST}.getElementById('uploads-ask')`);
  };
  // Scrolled to, as a person does, then clicked.
  const press = async (b, el) => { await b.eval(`${el}.scrollIntoView({ block: 'center' })`); await sleep(200); await b.click(el); };
  const sites = (b) => b.eval(`[...${ST}.querySelectorAll('.upload-site .row-label')].map((e) => e.textContent.trim()).join()`);
  let s;
  try {
    // The question, answered "Always on 127.0.0.1".
    s = await start('Always on 127.0.0.1');
    assert.deepEqual((await s.mcp.call('upload_file', { path: path.join(files, 'one.mp4') })).value?.uploaded, 'one.mp4');
    await openAgents(s.b);
    assert.equal(await sites(s.b), '127.0.0.1', 'Settings lists the site');
    s.mcp.close(); await s.b.quit(); await s.b.close();

    // Next time no question there: an answer of "Don’t upload" never comes into it.
    s = await start('Don’t upload');
    assert.equal((await s.mcp.call('upload_file', { path: path.join(files, 'two.mp4') })).value?.uploaded, 'two.mp4', 'no question on 127.0.0.1');

    // Never in Settings (a click): refused, and the agent is told where to change it.
    await openAgents(s.b);
    await press(s.b, `${ST}.getElementById('uploads-never')`);
    await s.b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentUploads === 'never')`);
    assert.match((await s.mcp.call('upload_file', { path: path.join(files, 'three.mp4') })).error, /turned off in Meridian's Settings/);

    // Back to Ask, and the site's bin: the question again (answered "Don’t upload" here).
    await press(s.b, `${ST}.getElementById('uploads-ask')`);
    await press(s.b, `${ST}.querySelector('.upload-site .icon-btn')`);
    await s.b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentUploads === 'ask' && r.settings.agentUploadSites.length === 0)`);
    assert.equal(await sites(s.b), '');
    assert.match((await s.mcp.call('upload_file', { path: path.join(files, 'four.mp4') })).error, /declined/);
  } finally {
    s?.mcp.close();
    await s?.b.close();
    server.close();
    for (const d of [profile, files]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// A site whose upload button makes its <input type=file> on click (or calls showOpenFilePicker):
// with no field on the page, the approved file waits for that tab's next chooser and the agent
// clicks the site's own button. A declined upload offers nothing, and the offer runs out.
const chooserPages = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/picker')) {
    return res.end(`<title>Picker</title><button id=up onclick="showOpenFilePicker().then((h) => h[0].getFile()).then((f) => { document.title = 'Picked ' + f.name + ' ' + f.size }, (e) => { document.title = 'Aborted ' + e.name })">Upload</button>`);
  }
  res.end(`<title>Studio</title><button id=up onclick="const i = document.createElement('input'); i.type = 'file'; i.style.display = 'none'; document.body.append(i); i.onchange = () => { document.title = 'Got ' + i.files[0].name + ' ' + i.files[0].size }; i.oncancel = () => { document.title = 'Cancelled' }; i.click()">Upload</button>`);
};

async function chooserRun(answer, extra, body) {
  const server = http.createServer(chooserPages);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  // Windows: not in the temp folder, which is under AppData, where Chrome's File System Access
  // blocklist keeps showOpenFilePicker out (a person's files are elsewhere too).
  const files = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), 'meridian-upload-')));
  const photo = path.join(files, 'photo.png');
  fs.writeFileSync(photo, Buffer.alloc(1234, 7));
  const b = await launch([`${origin}/`], { profile, args: [`--meridian-test-dialog-answer=${answer}`, '--meridian-test-cancel-file-choosers', ...extra] });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Studio')`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const title = (t) => b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === ${JSON.stringify(t)})`);
    await body({ b, mcp, origin, photo, title });
  } finally {
    mcp.close();
    await b.close();
    server.close();
    for (const d of [profile, files]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('upload_file: no field on the page — the approved file goes to the chooser the site’s own button opens', async () => {
  await chooserRun('Upload this file', [], async ({ mcp, origin, photo, title }) => {
    const offered = await mcp.call('upload_file', { path: photo });
    assert.equal(offered.value?.offered, 'photo.png', JSON.stringify(offered));
    assert.match(offered.value.next, /Click the site's upload button now/);
    await mcp.call('click', { selector: '#up' });
    await title('Got photo.png 1234');

    // Used once: the next click gets no file.
    await mcp.call('click', { selector: '#up' });
    await title('Cancelled');

    // showOpenFilePicker gets it the same way.
    await mcp.call('navigate', { url: `${origin}/picker` });
    await title('Picker');
    assert.equal((await mcp.call('upload_file', { path: photo })).value?.offered, 'photo.png');
    await mcp.call('click', { selector: '#up' });
    await title('Picked photo.png 1234');
  });
});

test('upload_file: a declined upload offers nothing to the site’s chooser', async () => {
  await chooserRun('Don’t upload', [], async ({ mcp, photo, title }) => {
    assert.match((await mcp.call('upload_file', { path: photo })).error, /declined/);
    await mcp.call('click', { selector: '#up' });
    await title('Cancelled');
  });
});

test('upload_file: the offer to the site’s chooser runs out', async () => {
  // 30 seconds for people; 2 here.
  await chooserRun('Upload this file', ['--meridian-test-upload-offer-seconds=2'], async ({ mcp, photo, title }) => {
    const offered = await mcp.call('upload_file', { path: photo });
    assert.match(offered.value?.next ?? '', /within 2 seconds/);
    await sleep(3000);
    await mcp.call('click', { selector: '#up' });
    await title('Cancelled');
  });
});
