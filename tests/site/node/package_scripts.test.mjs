// The serve and lab scripts: PORT picks the port, and the message names the real one.
// Run through npm: yarn 4 refuses to run scripts while the lockfile is out of date.
// Always a free port: 8000 and 8010 may be someone's running server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const refused = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});

async function serve(script, path, t) {
  const port = await freePort();
  // Its own process group, so one signal stops npm, the shell and python together.
  const child = spawn('npm', ['run', script], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await exited;
  };
  t.after(stop);

  let res;
  const deadline = Date.now() + 20_000;
  while (!res) {
    if (child.exitCode !== null) assert.fail(`npm run ${script} exited early:\n${out}`);
    assert.ok(Date.now() < deadline, `npm run ${script} never answered on ${port}:\n${out}`);
    res = await fetch(`http://127.0.0.1:${port}${path}`).catch(() => null);
    if (!res) await new Promise((r) => setTimeout(r, 100));
  }
  const body = await res.text();
  await stop();
  return { port, res, body, out, refusedAfter: await refused(port) };
}

test('serve: the landing page on $PORT', async (t) => {
  const { port, res, body, out, refusedAfter } = await serve('serve', '/', t);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(body, /<title>[^<]*Meridian[^<]*<\/title>/i);
  assert.match(out, new RegExp(`Serving the site at http://localhost:${port}/`));
  assert.ok(refusedAfter, 'the server stopped');
});

test('lab: the lab index on $PORT', async (t) => {
  const { port, res, body, out, refusedAfter } = await serve('lab', '/site/lab/', t);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(body, /<title>[^<]*Lab[^<]*<\/title>/);
  assert.match(out, new RegExp(`Design lab at http://localhost:${port}/site/lab/`));
  assert.ok(refusedAfter, 'the server stopped');
});
