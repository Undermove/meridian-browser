// Probe (not a test yet): what standard browser UI works in the WebUI browser window.
// Prints one line per feature. Run: node probe_core.mjs
import { launch, SB } from './harness.mjs';
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/download')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="probe.bin"' });
    return res.end('x'.repeat(1000));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Probe</title>
<form id=f action="/done" method=post><input id=u name=username autocomplete=username value="probe@example.com">
<input id=p type=password name=password autocomplete=current-password value="correct-horse-1"><button id=s>Sign in</button></form>
<p>findme findme</p><a id=dl href="/download">download</a>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

const b = await launch([url('/')]);
const list = async () => (await (await fetch(`${b.base}/json/list`)).json()).map((t) => `${t.type} ${t.url.slice(0, 70)}`);
try {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('targets at start:\n  ' + (await list()).join('\n  '));
  const page = (await (await fetch(`${b.base}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  let id = 0; const send = (method, params = {}) => new Promise((res) => { const i = ++id; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); res(m.result ?? m.error); } }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  // 1. password form submit -> save bubble?
  await send('Runtime.evaluate', { expression: `document.getElementById('f').submit()` });
  await new Promise((r) => setTimeout(r, 2500));
  console.log('after password submit:\n  ' + (await list()).join('\n  '));
  // 2. permission prompt
  await send('Page.navigate', { url: url('/') });
  await new Promise((r) => setTimeout(r, 1500));
  await send('Runtime.evaluate', { expression: `navigator.geolocation.getCurrentPosition(()=>{}, ()=>{}); 1`, userGesture: true });
  await new Promise((r) => setTimeout(r, 2000));
  console.log('after geolocation request:\n  ' + (await list()).join('\n  '));
  // 3. alert
  send('Runtime.evaluate', { expression: `setTimeout(() => alert('hi'), 10); 1` });
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after alert:\n  ' + (await list()).join('\n  '));
} finally { await b.close(); server.close(); }
