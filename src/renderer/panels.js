/* Meridian — panels over the main UI: the Archive, the downloads popover and the space theme editor.
 * Loaded after app.js and shares its globals (state, rt, space(), render(), save(), …).
 */

// ---------------------------------------------------------------- Archive

function openArchive() {
  closePanels();
  const overlay = document.createElement('div');
  overlay.id = 'archive-overlay';
  overlay.className = 'panel-overlay';
  overlay.innerHTML = `
    <div class="archive-card" role="dialog" aria-label="Archive">
      <div class="archive-head">
        <span class="archive-title">${icon('archive', 18)} Archive</span>
        <div class="archive-search">${icon('search', 15)}<input id="archive-q" placeholder="Search archived tabs" spellcheck="false" autocomplete="off"></div>
        <button class="icon-btn small" id="archive-close" title="Close (Esc)">${icon('x', 14)}</button>
      </div>
      <div class="archive-list" id="archive-list"></div>
      <div class="archive-foot"><span class="muted" id="archive-count"></span><div class="grow"></div><button class="btn small" id="archive-clear">Clear Archive…</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const q = $('#archive-q', overlay);
  const draw = () => drawArchive(overlay, q.value.trim().toLowerCase());
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePanels(); }
    if (e.key === 'Enter') { const first = $('.arch-row', overlay); if (first) restoreArchived(Number(first.dataset.i)); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePanels(); });
  $('#archive-close', overlay).onclick = closePanels;
  $('#archive-clear', overlay).onclick = async () => {
    if (!state.archive.length || !(await confirmBox('Clear the archive? Archived tabs are gone for good.', 'Clear'))) return;
    state.archive = []; save(); draw();
  };
  overlay.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); state.archive.splice(Number(rm.dataset.rm), 1); save(); return draw(); }
    const row = e.target.closest('.arch-row');
    if (row) restoreArchived(Number(row.dataset.i));
  });
  draw();
  setTimeout(() => q.focus(), 0);
}

function restoreArchived(i) {
  const entry = state.archive[i];
  closePanels();
  if (entry) reopenArchived(entry);
}

function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function drawArchive(overlay, q) {
  const list = $('#archive-list', overlay);
  const items = state.archive.map((a, i) => ({ a, i })).filter(({ a }) => !q || (a.title || '').toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q));
  $('#archive-count', overlay).textContent = state.archive.length ? `${state.archive.length} archived tab${state.archive.length === 1 ? '' : 's'}` : '';
  $('#archive-clear', overlay).disabled = !state.archive.length;
  if (!items.length) {
    list.innerHTML = `<div class="panel-empty">${icon(q ? 'search' : 'archive', 28)}<div class="pe-title">${q ? 'Nothing matches' : 'Nothing archived yet'}</div><div class="pe-sub">${q ? 'Try another word from the title or address.' : `Today tabs you close, clear or haven’t used for ${archiveAfterLabel()} land here, so you can always get them back.`}</div></div>`;
    return;
  }
  let last = '';
  const html = [];
  for (const { a, i } of items.slice(0, 300)) {
    const day = dayLabel(a.closedAt || 0);
    if (day !== last) { html.push(`<div class="arch-day">${esc(day)}</div>`); last = day; }
    const sp = state.spaces.find((s) => s.id === a.spaceId);
    const time = new Date(a.closedAt || 0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    html.push(`<div class="arch-row" data-i="${i}" title="${esc(a.url)}">
      <span class="favicon" style="width:16px;height:16px"><span class="letter" style="--lc:${esc(sp?.color || 'var(--space)')}">${esc((hostOf(a.url)[0] || '•').toUpperCase())}</span></span>
      <span class="arch-title">${esc(a.title || hostOf(a.url))}</span>
      <span class="arch-host">${esc(hostOf(a.url))}</span>
      ${sp ? `<span class="arch-space" style="--c:${esc(sp.color)}">${sp.icon ? `<em>${esc(sp.icon)}</em>` : '<i></i>'}${esc(sp.name)}</span>` : ''}
      <span class="arch-time">${esc(time)}</span>
      <button class="row-btn" data-rm="${i}" title="Remove from archive">${icon('x', 13)}</button>
    </div>`);
  }
  list.innerHTML = html.join('');
}

function archiveAfterLabel() {
  const h = state.settings.archiveAfterHours;
  return !h ? 'a while' : h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

// ---------------------------------------------------------------- downloads popover

const FILE_KINDS = [
  [/\.(zip|gz|tgz|rar|7z|tar|bz2|xz|dmg|iso)$/i, 'Archive', '#c58b3b'],
  [/\.(png|jpe?g|gif|webp|svg|heic|avif|bmp)$/i, 'Image', '#4e9bd8'],
  [/\.(mp4|mov|mkv|webm|avi)$/i, 'Video', '#a466d6'],
  [/\.(mp3|wav|flac|m4a|ogg)$/i, 'Audio', '#d6669b'],
  [/\.(pdf)$/i, 'PDF', '#e0534f'],
  [/\.(docx?|pages|rtf|txt|md|odt)$/i, 'Document', '#4f7fe0'],
  [/\.(xlsx?|csv|numbers|ods)$/i, 'Spreadsheet', '#3ea66b'],
  [/\.(pptx?|key|odp)$/i, 'Slides', '#e08a3b'],
];
function fileKind(name) {
  for (const [re, label, color] of FILE_KINDS) if (re.test(name)) return { label, color, ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').slice(0, 4).toUpperCase() };
  return { label: 'File', color: '#8a8f99', ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').slice(0, 4).toUpperCase() };
}

function toggleDownloads() {
  if ($('#downloads-pop')) return closePanels();
  closePanels();
  const pop = document.createElement('div');
  pop.id = 'downloads-pop';
  pop.className = 'popover';
  document.body.appendChild(pop);
  drawDownloads();
  const btn = $('#btn-downloads');
  const r = btn.getBoundingClientRect();
  const right = state.settings.sidebarRight;
  pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  pop.style.left = right ? '' : `${Math.max(8, r.left - 6)}px`;
  pop.style.right = right ? `${Math.max(8, window.innerWidth - r.right - 6)}px` : '';
  btn.classList.add('open');
  const away = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closePanels(); };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  window.addEventListener('blur', closePanels, { once: true });
  pop._cleanup = () => { document.removeEventListener('mousedown', away, true); btn.classList.remove('open'); };
  pop.addEventListener('click', (e) => {
    const row = e.target.closest('.dl-row');
    if (e.target.closest('#dl-clear')) { rt.downloads = rt.downloads.filter((d) => d.state === 'progressing' || d.state === 'started'); drawDownloads(); return; }
    if (row) { api.revealDownload(row.dataset.path); }
  });
}

function drawDownloads() {
  const pop = $('#downloads-pop');
  if (!pop) return;
  const list = rt.downloads;
  pop.innerHTML = `
    <div class="pop-head"><span>Downloads</span><div class="grow"></div>${list.some((d) => d.state !== 'progressing' && d.state !== 'started') ? '<button class="link-btn" id="dl-clear">Clear</button>' : ''}</div>
    ${list.length ? `<div class="dl-list">${list.map((d) => {
      const k = fileKind(d.name);
      const live = d.state === 'progressing' || d.state === 'started';
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const failed = d.state === 'cancelled' || d.state === 'interrupted';
      const sub = live ? `${fmtBytes(d.received)}${d.total ? ` of ${fmtBytes(d.total)}` : ''}` : failed ? (d.state === 'cancelled' ? 'Cancelled' : 'Failed') : `${fmtBytes(d.total || d.received)} · ${k.label}`;
      return `<div class="dl-row${failed ? ' failed' : ''}" data-path="${esc(d.path)}" title="Show in ${IS_MAC ? 'Finder' : 'folder'}">
        <span class="dl-ic" style="--c:${k.color}">${icon('file', 22)}<b>${esc(k.ext)}</b></span>
        <span class="dl-text"><span class="dl-name">${esc(d.name)}</span><span class="dl-sub">${esc(sub)}</span>${live ? `<span class="dl-bar"><i style="width:${d.total ? pct : 30}%" class="${d.total ? '' : 'indet'}"></i></span>` : ''}</span>
        <span class="dl-act">${icon('reveal', 15)}</span>
      </div>`;
    }).join('')}</div>` : `<div class="panel-empty small">${icon('download', 24)}<div class="pe-title">No downloads yet</div><div class="pe-sub">Files you download show up here.</div></div>`}`;
}

// ---------------------------------------------------------------- space theme editor

const THEME_PRESETS = [
  ['#8a8fe0'], ['#e08a9b'], ['#e0b27a'], ['#7fbf8e'], ['#6fb6d9'], ['#b48ae0'], ['#d98a6f'], ['#9aa3ad'],
  ['#ff8a65', '#f06292'], ['#7f7fd5', '#86a8e7'], ['#43cea2', '#185a9d'], ['#f7b267', '#f4845f'],
  ['#c471f5', '#fa71cd'], ['#4facfe', '#00f2fe'], ['#a8e063', '#56ab2f'], ['#30323d', '#6b6e80'],
];
const THEME_EMOJI = ['🏠', '💼', '🧪', '🎨', '📚', '🎮', '🎵', '✈️', '🛒', '💡', '🧠', '🚀', '🌿', '☕️', '🔥', '⭐️', '❤️', '🐙', '🦊', '🍀', '🌊', '⚡️', '🧩', '📷', '🏀', '🍕', '💰', '🛠️', '📝', '🗂️', '🌙', '☀️'];

function openThemeEditor(sp = space()) {
  if (!sp || EPHEMERAL) return;
  closePanels();
  if (sp.id !== state.activeSpaceId) switchSpace(sp.id);
  const original = { color: sp.color, color2: sp.color2, icon: sp.icon, name: sp.name };
  const overlay = document.createElement('div');
  overlay.id = 'theme-overlay';
  overlay.className = 'panel-overlay light';
  overlay.innerHTML = `
    <div class="theme-card" role="dialog" aria-label="Edit space theme">
      <div class="theme-preview" id="theme-preview">
        <div class="tp-sidebar">
          <div class="tp-url"></div>
          <div class="tp-space"><span id="tp-icon"></span><span id="tp-name"></span></div>
          <div class="tp-row a"></div><div class="tp-row"></div><div class="tp-row"></div><div class="tp-row short"></div>
        </div>
        <div class="tp-page"></div>
      </div>
      <div class="theme-body">
        <input class="theme-name" id="theme-name" value="${esc(sp.name)}" spellcheck="false" maxlength="40">
        <div class="theme-label">Colour</div>
        <div class="theme-swatches" id="theme-swatches">${THEME_PRESETS.map((p, i) => `<button class="sw" data-i="${i}" style="--a:${p[0]};--b:${p[1] || p[0]}" title="${p.length > 1 ? 'Gradient' : 'Solid'}"></button>`).join('')}</div>
        <div class="theme-custom">
          <label class="pick"><input type="color" id="theme-c1"><span>Colour</span></label>
          <label class="check-line"><input type="checkbox" id="theme-grad"> Gradient</label>
          <label class="pick" id="theme-c2-wrap"><input type="color" id="theme-c2"><span>Second colour</span></label>
        </div>
        <div class="theme-label">Icon</div>
        <div class="theme-emoji" id="theme-emoji"><button class="em none" data-e="" title="No icon">${icon('x', 14)}</button>${THEME_EMOJI.map((e) => `<button class="em" data-e="${e}">${e}</button>`).join('')}</div>
        <div class="theme-actions"><button class="btn" id="theme-cancel">Cancel</button><button class="btn accent" id="theme-done">Done</button></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const c1 = $('#theme-c1', overlay), c2 = $('#theme-c2', overlay), grad = $('#theme-grad', overlay);
  const sync = () => {
    c1.value = sp.color; c2.value = sp.color2 || shade(sp.color);
    grad.checked = !!sp.color2;
    $('#theme-c2-wrap', overlay).classList.toggle('off', !sp.color2);
    $('#theme-preview', overlay).style.setProperty('--a', sp.color);
    $('#theme-preview', overlay).style.setProperty('--b', sp.color2 || sp.color);
    $('#tp-icon', overlay).textContent = sp.icon || '';
    $('#tp-name', overlay).textContent = sp.name;
    $$('.sw', overlay).forEach((b) => { const p = THEME_PRESETS[b.dataset.i]; b.classList.toggle('on', p[0] === sp.color && (p[1] || null) === (sp.color2 || null)); });
    $$('.em', overlay).forEach((b) => b.classList.toggle('on', (b.dataset.e || null) === (sp.icon || null)));
    render(); // live: the whole window takes the colour
  };
  $('#theme-swatches', overlay).onclick = (e) => { const b = e.target.closest('.sw'); if (!b) return; const p = THEME_PRESETS[b.dataset.i]; sp.color = p[0]; if (p[1]) sp.color2 = p[1]; else delete sp.color2; sync(); };
  c1.oninput = () => { sp.color = c1.value; sync(); };
  c2.oninput = () => { sp.color2 = c2.value; sync(); };
  grad.onchange = () => { if (grad.checked) sp.color2 = shade(sp.color); else delete sp.color2; sync(); };
  $('#theme-emoji', overlay).onclick = (e) => { const b = e.target.closest('.em'); if (!b) return; sp.icon = b.dataset.e || null; sync(); };
  $('#theme-name', overlay).oninput = (e) => { sp.name = e.target.value.trim() || original.name; sync(); };
  const finish = (keep) => {
    if (!keep) { Object.assign(sp, original); if (!original.color2) delete sp.color2; }
    closePanels(); render(); save();
  };
  $('#theme-cancel', overlay).onclick = () => finish(false);
  $('#theme-done', overlay).onclick = () => finish(true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(true); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } if (e.key === 'Enter' && e.target.id === 'theme-name') finish(true); });
  overlay._finish = finish;
  sync();
  setTimeout(() => $('#theme-done', overlay).focus(), 0);
}

// A darker, hue-shifted partner colour for a one-click gradient.
function shade(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return '#6b6e80';
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  [r, g, b] = [r * 0.72 + b * 0.1, g * 0.68 + r * 0.08, b * 0.8 + 40].map((v) => Math.max(0, Math.min(255, Math.round(v))));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- shared

function closePanels() {
  for (const el of $$('#archive-overlay, #downloads-pop, #theme-overlay')) {
    el._cleanup?.();
    el.remove();
  }
}

// Small one-time UI wiring for the pieces above (and the private window's look).
function initPolish() {
  if (PRIVATE) {
    const badge = document.createElement('div');
    badge.className = 'private-badge';
    badge.innerHTML = `${icon('incognito', 14)}<span>Private</span>`;
    badge.title = 'Private window: no history, cookies or site data are kept after you close it.';
    $('.sb-top').insertBefore(badge, $('.sb-top .grow'));
    $('#empty-state .hint').innerHTML = `<div class="private-hint">${icon('incognito', 30)}<b>Private window</b><span>Pages you open here aren’t saved to history, and cookies and site data are deleted when you close the window.</span></div>`;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#downloads-pop')) closePanels();
  });
}
