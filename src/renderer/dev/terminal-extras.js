/* Workbench — the terminal as a place to look at what agents send. An image path it prints opens
 * large (wherever the file is), the session's images sit as thumbnails in the terminal's tab bar
 * (so the program never changes size), and a right click has the usual actions. */

const IMAGE_RE = /(?:^|[\s('"`[=])((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[^\s'"`()[\]<>:|\\/]+[\\/])*[^\s'"`()[\]<>:|\\/]+\.(?:png|jpe?g|gif|webp))(?=$|[\s'"`)\],.:;!?])/gi;
const QUOTED_IMAGE_RE = /(["'`])([^"'`\n]{1,512}?\.(?:png|jpe?g|gif|webp))\1/gi;
const PATH_START_RE = /(?:^|[\s(=])(?=[A-Za-z]:[\\/]|~[\\/]|\/)/g;
const SPACED_IMAGE_RE = /^[^\n"'`<>|]*?\.(?:png|jpe?g|gif|webp)(?=$|[\s"'`)\],.:;!?])/i;
const STRIP_MAX = 12;
const THUMB_MAX_BYTES = 8 << 20;

// What a printed path is: the answer is kept, a miss only briefly (the file may be about to appear).
const imageInfos = new Map();
function imageInfo(printed) {
  const key = `${S.project?.root || ''}\n${printed}`;
  const known = imageInfos.get(key);
  if (known && (known.info || Date.now() - known.at < 4000)) return Promise.resolve(known.info);
  return wb.termImageInfo(printed).catch(() => null).then((info) => {
    if (imageInfos.size > 500) imageInfos.clear();
    imageInfos.set(key, { info, at: Date.now() });
    return info;
  });
}

// The whole logical line around row `y` (0-based), and how to turn an offset in it into a cell.
function logicalLine(t, y) {
  const buf = t.xterm.buffer.active;
  let first = y;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  const cols = t.xterm.cols;
  let text = '';
  for (let i = first; i <= last; i++) text += (buf.getLine(i)?.translateToString(i === last) || '').padEnd(i === last ? 0 : cols);
  return { text, first, last, at: (offset) => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 }) };
}

function imagePathsIn(text) {
  const out = [];
  const add = (path, index) => {
    if (!out.some((o) => o.index === index && o.path.length === path.length)) out.push({ path, index });
  };
  for (const m of text.matchAll(IMAGE_RE)) add(m[1], m.index + m[0].length - m[1].length);
  // Folders with spaces (C:\\Users\\First Last, ~/Library/Application Support): in quotes, or
  // from where an absolute path starts up to the first image extension. The browser checks each.
  for (const m of text.matchAll(QUOTED_IMAGE_RE)) add(m[2], m.index + 1);
  let starts = 0;
  for (const m of text.matchAll(PATH_START_RE)) {
    if (++starts > 8) break;
    const start = m.index + m[0].length;
    const found = SPACED_IMAGE_RE.exec(text.slice(start, start + 512));
    if (found && /\s/.test(found[0])) add(found[0], start);
  }
  return out;
}

// What the file is called, when a shell printed its spaces escaped.
const unescapedPath = (p) => (wb.platform === 'win32' ? p : p.replace(/\\ /g, ' '));

// Of candidates over the same cells, the longest real path.
function longestImages(images) {
  const order = (p) => p.y * 100000 + p.x;
  const kept = [];
  for (const i of [...images].sort((a, b) => b.text.length - a.text.length)) {
    if (!kept.some((k) => order(k.range.start) <= order(i.range.end) && order(i.range.start) <= order(k.range.end))) kept.push(i);
  }
  return kept;
}

// Image paths as links, over what the terminal already links (a web address stays one).
function termExtraLinks(t, base) {
  const order = (p) => p.y * 100000 + p.x;
  const overlap = (a, b) => order(a.start) <= order(b.end) && order(b.start) <= order(a.end);
  return {
    provideLinks(y, done) {
      base.provideLinks(y, (links) => {
        const line = logicalLine(t, y - 1);
        const candidates = imagePathsIn(line.text).map((c) => ({ ...c, range: { start: line.at(c.index), end: line.at(c.index + c.path.length - 1) } }))
          .filter((c) => c.range.start.y <= y && c.range.end.y >= y && !(links || []).some((l) => l.isWeb !== false && /^https?:/.test(l.text) && overlap(l.range, c.range)));
        if (!candidates.length) return done(links);
        Promise.all(candidates.map(async (c) => {
          const info = await imageInfo(unescapedPath(c.path));
          return info ? { range: c.range, text: c.path, image: info, open: () => openImageViewer(info), activate: () => {} } : null;
        })).then((found) => {
          const images = longestImages(found.filter(Boolean));
          const rest = (links || []).filter((l) => !images.some((i) => overlap(i.range, l.range)));
          const all = rest.concat(images);
          done(all.length ? all : undefined);
        });
      });
    },
  };
}

// ------------------------------------------------------------------ thumbnails

async function thumbnailOf(img) {
  if (img.size > THUMB_MAX_BYTES) return '';
  try {
    const r = await wb.termImage(img.path);
    const el = new Image();
    el.src = `data:${r.mime};base64,${r.data}`;
    await el.decode();
    const k = Math.min(1, 64 / Math.max(el.naturalWidth, el.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(el.naturalWidth * k));
    c.height = Math.max(1, Math.round(el.naturalHeight * k));
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch { return ''; }
}

// What the program printed since the last look, and the screen (it redraws in place).
async function scanTermImages(t) {
  if (t.closed || t.scanning) { t.scanAgain = !t.closed; return; }
  t.scanning = true;
  try {
    const buf = t.xterm.buffer.active;
    const end = buf.length;
    const from = Math.max(0, end - 2000, Math.min(t.scannedTo ?? 0, end - t.xterm.rows));
    t.scannedTo = end;
    const fresh = [];
    for (let y = from; y < end; y++) {
      if (buf.getLine(y)?.isWrapped) continue;
      for (const c of imagePathsIn(logicalLine(t, y).text)) {
        if (!t.imagesSeen.has(c.path) && !fresh.includes(c.path)) fresh.push(c.path);
      }
    }
    for (const printed of fresh.slice(-8)) {
      const info = await imageInfo(printed);
      if (!info || t.closed) continue;
      t.imagesSeen.add(printed);
      if (t.images.some((i) => i.path === info.path)) continue;
      const img = { ...info, thumb: await thumbnailOf(info) };
      t.images.unshift(img);
      t.images.length = Math.min(t.images.length, STRIP_MAX);
      t.stripClosed = false;
      if (S.activeTerm === t) termStripRender();
    }
  } finally {
    t.scanning = false;
    if (t.scanAgain) { t.scanAgain = false; termScanSoon(t); }
  }
}
function termScanSoon(t) {
  clearTimeout(t.scanTimer);
  t.scanTimer = setTimeout(() => scanTermImages(t), 250);
}

function termStripRender() {
  const strip = document.getElementById('term-strip');
  if (!strip) return;
  const t = S.activeTerm;
  if (!t?.images?.length || t.stripClosed) { strip.hidden = true; strip.replaceChildren(); return; }
  strip.hidden = false;
  const thumbs = t.images.map((img) => {
    const b = document.createElement('button');
    b.className = 'term-thumb';
    b.dataset.path = img.path;
    b.title = img.path;
    b.setAttribute('aria-label', `Open ${img.name}`);
    if (img.thumb) {
      const i = document.createElement('img');
      i.src = img.thumb;
      i.alt = '';
      b.append(i);
    } else b.innerHTML = icon('eye', 13);
    b.addEventListener('click', () => openImageViewer(img));
    return b;
  });
  const close = document.createElement('button');
  close.id = 'term-strip-close';
  close.className = 'icon-btn small';
  close.title = 'Hide these images';
  close.innerHTML = icon('x', 11);
  close.addEventListener('click', () => { t.stripClosed = true; termStripRender(); t.xterm.focus(); });
  strip.replaceChildren(...thumbs, close);
}

// ------------------------------------------------------------------ the viewer

const VIEWER = { el: null, img: null, info: null, zoom: 1, fit: true };

function viewerEl() {
  if (VIEWER.el) return VIEWER.el;
  const el = document.createElement('div');
  el.id = 'img-viewer';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Image');
  el.innerHTML = `<div class="iv-bar"><span class="iv-name"></span><span class="iv-size muted"></span><span class="grow"></span>
    <button class="btn small" id="iv-zoom-out" title="Zoom out (−)">−</button><button class="btn small" id="iv-zoom-fit" title="Fit (0)">Fit</button><button class="btn small" id="iv-zoom-in" title="Zoom in (+)">+</button>
    <span class="iv-sep"></span>
    <button class="btn small" id="iv-copy-image">Copy Image</button><button class="btn small" id="iv-copy-path">Copy Path</button><button class="btn small" id="iv-reveal">${IS_MAC ? 'Show in Finder' : 'Show in Folder'}</button>
    <button class="icon-btn" id="iv-close" title="Close (Esc)">${icon('x', 14)}</button></div>
    <div class="iv-stage"><img alt=""></div>`;
  document.body.append(el);
  VIEWER.el = el;
  VIEWER.img = el.querySelector('img');
  el.querySelector('#iv-zoom-in').addEventListener('click', () => viewerZoom(1.25));
  el.querySelector('#iv-zoom-out').addEventListener('click', () => viewerZoom(0.8));
  el.querySelector('#iv-zoom-fit').addEventListener('click', viewerFit);
  el.querySelector('#iv-copy-path').addEventListener('click', () => copyText(VIEWER.info.path));
  el.querySelector('#iv-copy-image').addEventListener('click', viewerCopyImage);
  el.querySelector('#iv-reveal').addEventListener('click', () => wb.termImageReveal(VIEWER.info.path).catch((err) => toast(err.message)));
  el.querySelector('#iv-close').addEventListener('click', closeImageViewer);
  const stage = el.querySelector('.iv-stage');
  stage.addEventListener('click', (e) => { if (e.target === stage) closeImageViewer(); });
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    viewerZoom(e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });
  VIEWER.img.addEventListener('dblclick', () => (VIEWER.fit ? viewerSet(1) : viewerFit()));
  window.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if (document.querySelector('.wb-menu')) return;
    const act = { Escape: closeImageViewer, '+': () => viewerZoom(1.25), '=': () => viewerZoom(1.25), '-': () => viewerZoom(0.8), 0: viewerFit }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }, true);
  window.addEventListener('resize', () => { if (!el.hidden && VIEWER.fit) viewerFit(); });
  return el;
}

function viewerSet(zoom) {
  const { img } = VIEWER;
  VIEWER.fit = false;
  VIEWER.zoom = Math.min(128, Math.max(0.05, zoom));
  img.style.width = `${img.naturalWidth * VIEWER.zoom}px`;
  img.classList.toggle('pixels', VIEWER.zoom >= 3);
}
function viewerZoom(k) { viewerSet(VIEWER.zoom * k); }
function viewerFit() {
  const { img, el } = VIEWER;
  const stage = el.querySelector('.iv-stage');
  if (!img.naturalWidth) return;
  // A small picture is shown bigger than itself, up to a point: it is here to be looked at.
  const k = Math.min((stage.clientWidth - 48) / img.naturalWidth, (stage.clientHeight - 48) / img.naturalHeight, Math.max(1, 240 / Math.max(img.naturalWidth, img.naturalHeight)));
  viewerSet(k);
  VIEWER.fit = true;
}

async function openImageViewer(info) {
  const el = viewerEl();
  VIEWER.info = info;
  el.querySelector('.iv-name').textContent = info.name;
  el.querySelector('.iv-size').textContent = `${Math.max(1, Math.round(info.size / 1024))} KB`;
  VIEWER.img.removeAttribute('src');
  el.hidden = false;
  try {
    const r = await wb.termImage(info.path);
    if (VIEWER.info !== info) return;
    VIEWER.img.src = `data:${r.mime};base64,${r.data}`;
    await VIEWER.img.decode();
    if (VIEWER.info !== info) return;
    el.querySelector('.iv-size').textContent = `${VIEWER.img.naturalWidth} × ${VIEWER.img.naturalHeight} · ${Math.max(1, Math.round(info.size / 1024))} KB`;
    viewerFit();
  } catch (err) {
    closeImageViewer();
    toast(String(err?.message || 'Can’t show this image'), 4000);
  }
}

function closeImageViewer() {
  if (!VIEWER.el || VIEWER.el.hidden) return;
  VIEWER.el.hidden = true;
  VIEWER.info = null;
  VIEWER.img.removeAttribute('src');
  S.activeTerm?.xterm.focus();
}

async function viewerCopyImage() {
  const { img } = VIEWER;
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((done) => c.toBlob(done, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied');
  } catch { toast('Could not copy'); }
}

// ------------------------------------------------------------------ the right click

function linkAt(t, provider, e) {
  return new Promise((resolve) => {
    const screen = t.el.querySelector('.xterm-screen')?.getBoundingClientRect();
    const cell = t.xterm._core._renderService?.dimensions?.css?.cell;
    if (!screen || !cell?.width) return resolve(null);
    const x = Math.floor((e.clientX - screen.left) / cell.width) + 1;
    const row = Math.floor((e.clientY - screen.top) / cell.height);
    if (x < 1 || row < 0 || row >= t.xterm.rows) return resolve(null);
    const y = t.xterm.buffer.active.viewportY + row + 1;
    provider.provideLinks(y, (links) => resolve((links || []).find((l) => {
      const { start: a, end: b } = l.range;
      return (y > a.y || (y === a.y && x >= a.x)) && (y < b.y || (y === b.y && x <= b.x));
    }) || null));
  });
}

async function termPasteFromMenu(t) {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (text) {
    // The same care as ⌘V: a key goes to the vault, not into the scrollback.
    const found = window.MeridianSecrets ? MeridianSecrets.find(text) : [];
    if (found.length && !t.exited && typeof pasteSecretDialog === 'function') pasteSecretDialog(t, text, found);
    else if (!t.exited) t.xterm.paste(text);
    t.xterm.focus();
    return;
  }
  try {
    for (const it of await navigator.clipboard.read()) {
      const type = it.types.find((x) => x.startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      await pathsOf(t, [new File([blob], 'image.png', { type })], false);
      return;
    }
  } catch {}
  toast('Nothing to paste');
}

function termMenus(t, provider) {
  // A program that takes the mouse: a shell's vim or tmux keeps the right button (⇧ gets the menu);
  // an agent has no use for it, so there it is the menu.
  const takesMouse = () => t.xterm.modes.mouseTrackingMode !== 'none';
  const ours = (e) => !takesMouse() || e.shiftKey || t.kind !== 'shell';
  const hideFromProgram = (e) => {
    if (e.button === 2 && takesMouse() && ours(e)) e.stopPropagation();
  };
  t.el.addEventListener('mousedown', hideFromProgram, true);
  t.el.addEventListener('mouseup', hideFromProgram, true);
  t.el.addEventListener('contextmenu', async (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    const link = await linkAt(t, provider, e);
    const web = link && /^https?:/.test(link.text);
    // The agent's whole answer, whatever the screen wrapped or scrolled away.
    const answer = await wb.termLastAnswer(t.id).catch(() => '');
    const items = [
      ...(link ? [{ id: 'open', label: 'Open' }, { id: 'copy-link', label: web ? 'Copy Link' : 'Copy Path' }, { type: 'separator' }] : []),
      { id: 'copy', label: 'Copy', enabled: t.xterm.hasSelection() },
      ...(answer ? [{ id: 'copy-answer', label: 'Copy Last Answer' }] : []),
      { id: 'paste', label: 'Paste', enabled: !t.exited },
      { id: 'select-all', label: 'Select All' },
      { type: 'separator' },
      { id: 'clear', label: 'Clear' },
    ];
    const choice = await wb.menu(items);
    if (choice === 'open') link.open();
    if (choice === 'copy-link') copyText(link.image?.path || link.text);
    if (choice === 'copy') copyText(t.xterm.getSelection());
    if (choice === 'copy-answer') copyText(answer);
    if (choice === 'paste') await termPasteFromMenu(t);
    if (choice === 'select-all') t.xterm.selectAll();
    if (choice === 'clear') t.xterm.clear();
    if (choice !== 'open') t.xterm.focus();
  });
}

// Called for each new terminal, with its link provider.
function termExtras(t, provider) {
  t.images = [];
  t.imagesSeen = new Set();
  t.xterm.onWriteParsed(() => termScanSoon(t));
  termMenus(t, provider);
}

// Node (the fuzz targets in fuzz/): the pure parsers. In the page `module` is undefined.
if (typeof module === 'object' && module.exports) module.exports = { imagePathsIn, longestImages };
