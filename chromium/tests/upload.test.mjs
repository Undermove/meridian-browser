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
