// Every way Chromium's context menus reach Google Lens: none of them may crash Meridian. Lens's
// overlay wants Chromium's own window and CHECK-crashed in Meridian's (a user's report, 17.11.2026:
// OverlayBaseController::ShowOverlay from a screenshot of the page). Image search was fixed in 0.6.4;
// here the page, a video frame and a PDF too, each from a real right click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMMANDS = {
  LENS_REGION_SEARCH: 50174,          // "Search with Google Lens" on a page
  LENS_OVERLAY: 50193,                // the overlay's own item
  SEARCHLENSFORIMAGE: 50127,
  SEARCHWEBFORIMAGE: 50124,
  SEARCHLENSFORVIDEOFRAME: 50134,
  SEARCHWEBFORVIDEOFRAME: 50135,
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALUlEQVR4nO3NMQkAAAwDsPo3vckolED+5JKKzioWi8VisVgsFovFYrFYLB6NH6r1OhvW1o1iAAAAAElFTkSuQmCC', 'base64');
// A one-page PDF with a line of text.
function pdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 24 Tf 72 700 Td (A page of a PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(pdf()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/video') {
      // A video with a frame: a canvas stream recorded into the element.
      return res.end(`<!doctype html><title>Video</title><body style="margin:0"><video id=v width=300 height=200 muted></video><script>
        const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, 300, 200); }, 50);
        const v = document.getElementById('v'); v.srcObject = c.captureStream(20); v.play();
      </script>`);
    }
    res.end('<!doctype html><title>Article</title><body style="margin:0"><p style="font:20px sans-serif;padding:20px">Some text of an article</p><img id=pic src="/pic.png" width=200 height=200>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function rightClick(page, x, y) {
  for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'right'], ['mouseReleased', 'right']]) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
  }
}

const CASES = [
  // [what, path, where to click, the menu items it has]
  ['the page', '/article', [400, 400], ['LENS_REGION_SEARCH', 'LENS_OVERLAY']],
  ['a picture', '/article', [100, 150], ['SEARCHLENSFORIMAGE', 'SEARCHWEBFORIMAGE', 'LENS_REGION_SEARCH']],
  ['a video frame', '/video', [150, 100], ['SEARCHLENSFORVIDEOFRAME', 'SEARCHWEBFORVIDEOFRAME']],
];

for (const [what, p, [x, y], items] of CASES) {
  for (const item of items) {
    test(`right click on ${what}, ${item}: Meridian stays up`, async () => {
      const server = await serve();
      const url = `http://127.0.0.1:${server.address().port}${p}`;
      const b = await launch([url], { args: [`--meridian-test-context-menu-command=${COMMANDS[item]}`] });
      try {
        const page = await b.page(url);
        if (p === '/article') await page.waitFor(`document.getElementById('pic').complete`);
        if (p === '/video') await page.waitFor(`document.getElementById('v').readyState >= 2`, 15000);
        await rightClick(page, x, y);
        await sleep(3000);
        assert.equal(b.proc.exitCode, null, 'the browser is running');
        assert.equal(b.proc.signalCode, null, 'the browser is running');
        assert.equal(await b.eval('1 + 1'), 2);
        // The page is still there.
        assert.ok((await b.eval(`[...app.$.tabstrip.tabs_.values()].map((t) => t.url)`)).includes(url));
        page.close();
      } finally { await b.close(); server.close(); }
    });
  }
}

test('right click in a PDF, Search with Google Lens: Meridian stays up', async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/doc.pdf`;
  const b = await launch([url], { args: [`--meridian-test-context-menu-command=${COMMANDS.LENS_REGION_SEARCH}`] });
  try {
    const page = await b.page(url);
    await sleep(3000);  // the viewer draws the page
    await rightClick(page, 300, 200);
    await sleep(3000);
    assert.equal(b.proc.exitCode, null, 'the browser is running');
    assert.equal(b.proc.signalCode, null, 'the browser is running');
    assert.equal(await b.eval('1 + 1'), 2);
    page.close();
  } finally { await b.close(); server.close(); }
});
