/* Meridian — Settings window (meridian://app/settings.html).
 *
 * State flow: the main UI renderer owns state.json. It sends main a snapshot (settings, profiles,
 * spaces) after every change; main forwards it here (onState). Changes go out as patches
 * (S.set) or named actions (S.action); main validates them and hands them to the UI renderer, which
 * applies and saves them and sends a new snapshot back. So every change shows up live everywhere.
 *
 * Sections register themselves with registerSection(); settings-ai.js adds the AI section.
 */

const S = window.meridianSettings;
const IS_MAC = S.platform === 'darwin';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEARCH_ENGINES = { google: 'Google', duckduckgo: 'DuckDuckGo', kagi: 'Kagi', bing: 'Bing', yandex: 'Yandex', perplexity: 'Perplexity' };
const ARCHIVE_OPTIONS = [[12, '12 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days'], [0, 'Never']];
const UNLOAD_OPTIONS = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Never']];

const ctx = {
  info: null,            // settings:get result (snapshot, shortcuts, platform, version, mcp, …)
  section: 'general',
  get snap() { return this.info?.snapshot || { settings: {}, profiles: [], spaces: [] }; },
  get settings() { return this.snap.settings || {}; },
  // Optimistic: show the change right away; the snapshot that comes back confirms it.
  set(patch) {
    Object.assign(this.snap.settings, patch);
    return S.set(patch);
  },
};

// IPC answers that might hang (they shouldn't) must not keep a section from drawing.
const withTimeout = (p, fallback, ms = 3000) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

// ---------------------------------------------------------------- sections registry

const SECTIONS = [];
function registerSection(def) {
  SECTIONS.push(def);
  SECTIONS.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------- building blocks

const row = (label, control, desc = '', extra = '') => `
  <div class="row ${extra}">
    <div class="row-text"><div class="row-label">${label}</div>${desc ? `<div class="row-desc">${desc}</div>` : ''}</div>
    <div class="row-control">${control}</div>
  </div>`;
const group = (title, body, note = '') => `
  <section class="group">
    ${title ? `<h2>${title}</h2>` : ''}
    <div class="card">${body}</div>
    ${note ? `<p class="note">${note}</p>` : ''}
  </section>`;
const select = (id, options, value) => `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const toggle = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
const segmented = (name, options, value) => `<div class="segmented" data-name="${name}">${options.map(([v, l, ic]) => `<button class="seg ${String(v) === String(value) ? 'on' : ''}" data-value="${esc(v)}">${ic ? icon(ic, 14) : ''}<span>${esc(l)}</span></button>`).join('')}</div>`;
const button = (id, label, cls = '', attrs = '') => `<button class="btn ${cls}" id="${id}" ${attrs}>${label}</button>`;

function onSegment(root, name, fn) {
  const el = $(`.segmented[data-name="${name}"]`, root);
  el?.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    $$('.seg', el).forEach((x) => x.classList.toggle('on', x === b));
    fn(b.dataset.value);
  });
}

function toast(text, { timeout = 2600 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, timeout);
}

function dialog(html, onMount) {
  const overlay = $('#dialog-overlay');
  const box = $('#dialog');
  box.innerHTML = html;
  overlay.hidden = false;
  const close = () => { overlay.hidden = true; box.innerHTML = ''; overlay.onmousedown = null; };
  overlay.onmousedown = (e) => { if (e.target === overlay) { close(); overlay.dispatchEvent(new Event('dismiss')); } };
  onMount?.(box, close);
  return close;
}

function confirmBox(title, detail, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    dialog(`
      <h3>${esc(title)}</h3>${detail ? `<p>${esc(detail)}</p>` : ''}
      <div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`,
    (box, close) => {
      $('[data-a="ok"]', box).focus();
      box.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) { close(); resolve(a === 'ok'); } });
      $('#dialog-overlay').addEventListener('dismiss', () => resolve(false), { once: true });
    });
  });
}

function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    dialog(`
      <h3>${esc(title)}</h3>
      <input class="text" id="ask" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">
      <div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="ok">OK</button></div>`,
    (box, close) => {
      const input = $('#ask', box);
      input.focus(); input.select();
      const done = (v) => { close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
      box.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'ok' ? input.value.trim() : null); });
      $('#dialog-overlay').addEventListener('dismiss', () => resolve(null), { once: true });
    });
  });
}

const spaceChip = (sp) => `<span class="chip"><span class="chip-dot" style="--c:${esc(sp.color)}">${sp.icon ? esc(sp.icon) : ''}</span>${esc(sp.name)}</span>`;

// ---------------------------------------------------------------- member card
// Like Arc's member card at the top of its settings: your name, since when you've used Meridian, in
// your space's colours. It tilts toward the cursor with a holographic sheen; click the name to change it.

const MERIDIAN_MARK = '<svg class="mc-mark" viewBox="230 400 564 330" aria-hidden="true"><path d="M260 680 A252 252 0 0 1 764 680" fill="none" stroke="currentColor" stroke-width="84" stroke-linecap="round"/><circle cx="512" cy="680" r="46" fill="currentColor"/></svg>';

function memberCard() {
  const { spaces = [], activeSpaceId, stats = {} } = ctx.snap;
  const sp = spaces.find((x) => x.id === activeSpaceId) || spaces[0] || {};
  const c1 = sp.color || '#8a8fe0';
  const c2 = sp.color2 || spaces.find((x) => x.color && x.color !== c1)?.color || '#e48aa5';
  const m = ctx.info?.member || { since: Date.now(), name: '' };
  const name = ctx.settings.memberName || m.name || 'Meridian Member';
  const since = new Date(m.since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // A stable member number from the profile's birth time.
  const no = String(Math.floor(m.since / 1000) % 100000000).padStart(8, '0').replace(/(\d{4})(\d{4})/, '$1 $2');
  const fig = (n, l) => `<div class="mc-stat"><b>${Number(n || 0).toLocaleString()}</b><span>${l}</span></div>`;
  return `
    <div class="member-wrap">
      <div class="member-card" id="member-card" style="--c1:${esc(c1)};--c2:${esc(c2)}">
        <div class="mc-sheen"></div>
        <div class="mc-top">${MERIDIAN_MARK}<span class="mc-word">Meridian</span><span class="mc-no">No. ${no}</span></div>
        <div class="mc-bottom">
          <div>
            <button class="mc-name" id="member-name" title="Change name">${esc(name)}</button>
            <div class="mc-since">Member since ${esc(since)}</div>
          </div>
          <div class="mc-stats">${fig(spaces.length, spaces.length === 1 ? 'space' : 'spaces')}${fig(stats.tabs, 'tabs')}${fig(stats.history, 'visits')}</div>
        </div>
      </div>
    </div>`;
}

function mountMemberCard(root) {
  const card = $('#member-card', root);
  if (!card) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.addEventListener('pointermove', (e) => {
    if (reduce) return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--rx', `${(0.5 - y) * 14}deg`);
    card.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
    card.style.setProperty('--mx', `${x * 100}%`);
    card.style.setProperty('--my', `${y * 100}%`);
    card.classList.add('tilt');
  });
  card.addEventListener('pointerleave', () => { card.classList.remove('tilt'); card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  $('#member-name', root).onclick = async () => {
    const v = await askText('Name on your card', ctx.settings.memberName || ctx.info?.member?.name || '', 'Your name');
    if (v === null) return;
    await ctx.set({ memberName: v.slice(0, 40) });
    showSection('general');
  };
}

// ---------------------------------------------------------------- General

registerSection({
  id: 'general', label: 'General', icon: 'sliders', order: 10,
  async render(el) {
    const s = ctx.settings;
    const [isDefault, arc] = await Promise.all([withTimeout(S.isDefaultBrowser(), false), withTimeout(S.arcAvailable(), false)]);
    el.innerHTML = `
      ${memberCard()}
      ${group('Appearance', `
        ${row('Theme', segmented('appearance', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], s.appearance || 'system'))}
        ${row('Sidebar position', segmented('sidebar', [['left', 'Left'], ['right', 'Right']], s.sidebarRight ? 'right' : 'left'))}
        ${row('Mode', segmented('mode', [['everyday', 'Everyday'], ['creative', 'AI for work'], ['developer', 'Developer']], s.mode || 'developer'), 'Everyday and AI for work hide the developer tools (Workbench, Mission Control). Nothing is removed — switch any time.')}
        ${row('Space colours', button('edit-theme', `${icon('palette', 14)} Edit Space Theme…`), 'Each space has its own colour, gradient and icon.')}
      `)}
      ${group('Browsing', `
        ${row('Search engine', select('engine', Object.entries(SEARCH_ENGINES), s.searchEngine || 'google'), 'Used by the command bar and when you search from the URL bar.')}
        ${row('Default browser', isDefault
          ? `<span class="ok">${icon('check', 14)} Meridian is your default browser</span>`
          : button('make-default', 'Make Default', 'primary'), 'Links from other apps open in Meridian, routed by <a href="#links" data-goto="links">Air Traffic Control</a>.')}
      `)}
      ${group('Tabs', `
        ${row('Archive Today tabs after', select('archive', ARCHIVE_OPTIONS, s.archiveAfterHours ?? 12), 'Unpinned tabs you haven’t looked at move to the archive. Pinned tabs and favorites stay.')}
        ${row('Memory saver', select('unload', UNLOAD_OPTIONS, s.unloadAfterMinutes ?? 60), 'Pages you haven’t looked at for a while are put to sleep and reload when you come back.')}
      `)}
      ${group('Get started', `
        ${row('Import from Arc', button('import', arc ? 'Import…' : 'Arc not found', '', arc ? '' : 'disabled'), 'Spaces, colours, pinned tabs, folders and favorites. Logins don’t transfer.')}
        ${row('Welcome tour', button('tour', 'Show Again'), 'The onboarding: theme, import, default browser, basics and AI.')}
      `)}`;
    onSegment(el, 'appearance', (v) => ctx.set({ appearance: v }));
    onSegment(el, 'sidebar', (v) => ctx.set({ sidebarRight: v === 'right' }));
    onSegment(el, 'mode', (v) => ctx.set({ mode: v }));
    $('#engine', el).onchange = (e) => ctx.set({ searchEngine: e.target.value });
    $('#archive', el).onchange = (e) => ctx.set({ archiveAfterHours: Number(e.target.value) });
    $('#unload', el).onchange = (e) => ctx.set({ unloadAfterMinutes: Number(e.target.value) });
    $('#make-default', el)?.addEventListener('click', async () => {
      const r = await S.setDefaultBrowser();
      if (!r.packaged) toast('Works from the built app (npm run dist), not from dev mode', { timeout: 4500 });
      else { toast(r.ok ? 'Your system will ask you to confirm' : 'Could not set the default browser'); setTimeout(() => showSection('general'), 1500); }
    });
    $('#import', el)?.addEventListener('click', () => S.action('import-arc'));
    mountMemberCard(el);
    $('#tour', el).onclick = () => S.action('onboarding');
    $('#edit-theme', el).onclick = () => S.action('edit-theme');
  },
});

// ---------------------------------------------------------------- Profiles

registerSection({
  id: 'profiles', label: 'Profiles', icon: 'users', order: 20,
  render(el) {
    const { profiles = [], spaces = [] } = ctx.snap;
    el.innerHTML = `
      ${group('Profiles', profiles.map((p) => {
        const used = spaces.filter((sp) => sp.profileId === p.id);
        return `
          <div class="row profile" data-id="${esc(p.id)}">
            <div class="avatar" style="--c:${esc(used[0]?.color || '#9aa3ad')}">${esc((p.name[0] || '?').toUpperCase())}</div>
            <div class="row-text">
              <div class="row-label">${esc(p.name)}${p.id === 'default' ? ' <span class="tag">Default</span>' : ''}</div>
              <div class="row-desc chips">${used.length ? used.map(spaceChip).join('') : 'Not used by any space'}</div>
            </div>
            <div class="row-control">
              <button class="icon-btn" data-act="rename" title="Rename">${icon('pencil', 15)}</button>
              <button class="btn small" data-act="clear">Clear Data…</button>
              <button class="icon-btn danger" data-act="delete" title="${used.length ? 'Used by a space' : 'Delete profile'}" ${used.length || p.id === 'default' ? 'disabled' : ''}>${icon('trash', 15)}</button>
            </div>
          </div>`;
      }).join('') + `<div class="row add-row"><button class="btn" id="add-profile">${icon('plus', 14)} New Profile</button></div>`,
      'Each profile keeps its own cookies, logins and site data, like separate browsers. Spaces choose their profile: right-click a space and pick Profile.')}`;
    $('#add-profile', el).onclick = async () => {
      const name = await askText('New profile', '', 'Work, Personal, Client…');
      if (name) S.action('profile-add', { name });
    };
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      const id = b?.closest('.profile')?.dataset.id;
      const p = id && profiles.find((x) => x.id === id);
      if (!p || b.disabled) return;
      if (b.dataset.act === 'rename') { const name = await askText('Rename profile', p.name); if (name) S.action('profile-rename', { id, name }); }
      if (b.dataset.act === 'clear' && await confirmBox(`Clear all data for “${p.name}”?`, 'Cookies, logins, cache and site storage for this profile are deleted. Tabs stay.', 'Clear Data', true)) {
        await S.clearProfileData(id); toast('Profile data cleared');
      }
      if (b.dataset.act === 'delete' && await confirmBox(`Delete “${p.name}”?`, 'Its favorites and site data are removed.', 'Delete', true)) S.action('profile-delete', { id });
    });
  },
});

// ---------------------------------------------------------------- Links (Air Traffic Control)

function targetOptions(spaces) {
  return [['little', 'Little Window'], ['main', 'Current Space'], ...spaces.map((sp) => [`space:${sp.id}`, `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`])];
}

registerSection({
  id: 'links', label: 'Links', icon: 'route', order: 30,
  async render(el) {
    const atc = JSON.parse(JSON.stringify(ctx.settings.atc || { fallback: 'little', rules: [] }));
    atc.rules ||= [];
    const spaces = ctx.snap.spaces || [];
    const isDefault = await S.isDefaultBrowser().catch(() => false);
    const draw = () => {
      el.innerHTML = `
        <div class="hero">
          <div class="hero-ic">${icon('route', 22)}</div>
          <div><h1>Air Traffic Control</h1><p>Send links you open in other apps (Slack, Mail, Notion…) to the right place automatically.</p></div>
        </div>
        ${isDefault ? '' : `<div class="banner">${icon('info', 15)}<span>Meridian isn’t your default browser yet, so links from other apps open elsewhere.</span>${button('make-default', 'Make Default', 'small')}</div>`}
        ${group('Rules', `
          ${atc.rules.length ? atc.rules.map((r, i) => `
            <div class="row rule" data-i="${i}">
              <span class="rule-if">If link is on</span>
              <input class="text rule-pattern" value="${esc(r.pattern)}" placeholder="github.com or notion.so/acme/*" spellcheck="false">
              <span class="rule-arrow">${icon('arrowRight', 14)}</span>
              ${select(`rule-target-${i}`, targetOptions(spaces), r.target).replace('<select', '<select class="rule-target"')}
              <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('chevronUp', 14)}</button>
              <button class="icon-btn danger" data-act="del" title="Remove rule">${icon('trash', 15)}</button>
            </div>`).join('') : `<div class="empty">${icon('route', 20)}<div>No rules yet. Add one to send, say, <b>github.com</b> to your Work space.</div></div>`}
          <div class="row add-row"><button class="btn" id="add-rule">${icon('plus', 14)} Add Rule</button></div>
        `, 'Rules are checked top to bottom. “github.com” covers its subdomains; use * for wildcards, or add a path like notion.so/acme/*.')}
        ${group('Everything else', `
          ${row('Other links open in', select('fallback', [['little', 'Little Window'], ['main', 'Current Space']], atc.fallback), 'The Little window is a small window for a quick look; “Open in Meridian” moves the page into your sidebar.')}
        `)}
        ${group('Try it', `
          <div class="row"><input class="text" id="test-url" placeholder="Paste a link to see where it would go" spellcheck="false"><span id="test-result" class="muted"></span></div>
        `)}`;
      bind();
    };
    const commit = () => ctx.set({ atc: JSON.parse(JSON.stringify(atc)) });
    const bind = () => {
      $('#make-default', el)?.addEventListener('click', async () => { const r = await S.setDefaultBrowser(); toast(r.packaged ? 'Your system will ask you to confirm' : 'Works from the built app, not from dev mode'); });
      $('#add-rule', el).onclick = () => { atc.rules.push({ id: Math.random().toString(36).slice(2, 10), pattern: '', target: spaces[0] ? `space:${spaces[0].id}` : 'main' }); draw(); $$('.rule-pattern', el).at(-1)?.focus(); };
      $('#fallback', el).onchange = (e) => { atc.fallback = e.target.value; commit(); };
      $$('.rule', el).forEach((r) => {
        const i = Number(r.dataset.i);
        $('.rule-pattern', r).addEventListener('change', (e) => { atc.rules[i].pattern = e.target.value.trim(); commit(); });
        $('.rule-target', r).addEventListener('change', (e) => { atc.rules[i].target = e.target.value; commit(); });
        r.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (act === 'del') { atc.rules.splice(i, 1); commit(); draw(); }
          if (act === 'up' && i > 0) { [atc.rules[i - 1], atc.rules[i]] = [atc.rules[i], atc.rules[i - 1]]; commit(); draw(); }
        });
      });
      const test = async () => {
        const v = $('#test-url', el).value.trim();
        const out = $('#test-result', el);
        if (!v) { out.textContent = ''; return; }
        const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
        const r = await S.routeTest(atc, url);
        const sp = spaces.find((x) => x.id === r.spaceId);
        out.innerHTML = `${icon('arrowRight', 13)} ${r.target === 'little' ? 'Little Window' : r.target === 'space' ? esc(sp?.name || 'Space') : 'Current Space'}${r.pattern ? ` <span class="muted">(rule “${esc(r.pattern)}”)</span>` : ' <span class="muted">(no rule matched)</span>'}`;
      };
      $('#test-url', el).addEventListener('input', test);
    };
    draw();
  },
});

// ---------------------------------------------------------------- Shortcuts

registerSection({
  id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', order: 40,
  render(el) {
    const q = el.dataset.q || '';
    const rows = ctx.info.shortcuts;
    const groups = [...new Set(rows.map((r) => r.group))];
    const matchQ = (r) => !q || `${r.label} ${r.group} ${r.display}`.toLowerCase().includes(q.toLowerCase());
    const custom = rows.filter((r) => r.accel !== r.defaultAccel).length;
    el.innerHTML = `
      <div class="search-row">
        <div class="search">${icon('search', 15)}<input id="sc-search" placeholder="Search shortcuts" value="${esc(q)}" spellcheck="false"></div>
        ${custom ? button('reset-all', `Reset All (${custom})`, 'small') : ''}
      </div>
      ${groups.map((g) => {
        const list = rows.filter((r) => r.group === g && matchQ(r));
        if (!list.length) return '';
        return group(g, list.map((r) => `
          <div class="row sc-row ${r.alias ? 'alias' : ''}" data-id="${esc(r.id)}">
            <div class="row-text"><div class="row-label">${esc(r.label)}</div></div>
            <div class="row-control">
              ${r.accel !== r.defaultAccel ? `<button class="link-btn" data-act="reset" title="Default: ${esc(r.defaultDisplay || 'none')}">Reset</button>` : ''}
              <button class="keys ${r.accel ? '' : 'none'}" data-act="record" title="Click to change">${r.accel ? keyCaps(r.display) : 'Add Shortcut'}</button>
              ${r.accel ? `<button class="icon-btn" data-act="clear" title="Remove shortcut">${icon('x', 13)}</button>` : '<span class="icon-btn-spacer"></span>'}
            </div>
          </div>`).join(''));
      }).join('') || `<div class="empty">${icon('search', 20)}<div>No shortcuts match “${esc(q)}”.</div></div>`}`;
    const search = $('#sc-search', el);
    search.addEventListener('input', () => { el.dataset.q = search.value; const pos = search.selectionStart; this.render(el); const s2 = $('#sc-search', el); s2.focus(); s2.setSelectionRange(pos, pos); });
    $('#reset-all', el)?.addEventListener('click', async () => {
      if (await confirmBox('Reset all shortcuts to their defaults?', '', 'Reset All')) ctx.set({ shortcutOverrides: {} });
    });
    el.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      const r = b && rows.find((x) => x.id === b.closest('.sc-row')?.dataset.id);
      if (!r) return;
      const overrides = { ...(ctx.settings.shortcutOverrides || {}) };
      if (b.dataset.act === 'reset') { delete overrides[r.id]; return ctx.set({ shortcutOverrides: overrides }); }
      if (b.dataset.act === 'clear') { overrides[r.id] = ''; return ctx.set({ shortcutOverrides: overrides }); }
      if (b.dataset.act === 'record') recordShortcut(r, b);
    };
  },
});

function keyCaps(display) {
  // "⇧⌘T" -> ⇧ ⌘ T caps; "Ctrl+Shift+T" -> Ctrl Shift T
  const parts = IS_MAC ? [...display.matchAll(/[⌃⌥⇧⌘]|Esc|Space|.+$/g)].map((m) => m[0]) : display.split('+');
  return parts.map((p) => `<kbd>${esc(p)}</kbd>`).join('');
}

let recording = null;
async function recordShortcut(r, btn) {
  if (recording) stopRecording();
  recording = { r, btn };
  btn.classList.add('recording');
  btn.innerHTML = 'Type a shortcut…';
  await S.record(true);
  const stop = (e) => { if (!btn.contains(e.target)) { stopRecording(); showSection('shortcuts'); } };
  recording.stop = stop;
  setTimeout(() => document.addEventListener('mousedown', stop, true), 0);
}
function stopRecording() {
  if (!recording) return;
  document.removeEventListener('mousedown', recording.stop, true);
  recording = null;
  S.record(false);
}
S.onRecorded(async (res) => {
  if (!recording) return;
  const { r } = recording;
  stopRecording();
  if (res.cancel) return showSection('shortcuts');
  if (!res.accel) { toast('Use a modifier: ⌘, ⌃, ⌥ or ⇧ plus a key'); return showSection('shortcuts'); }
  const overrides = { ...(ctx.settings.shortcutOverrides || {}) };
  const clash = ctx.info.shortcuts.find((x) => x.id !== r.id && x.accel === res.accel);
  if (clash) {
    const ok = await confirmBox(`${res.display} is used by “${clash.label}”`, `Use it for “${r.label}” instead? “${clash.label}” will have no shortcut.`, 'Use for ' + r.label);
    if (!ok) return showSection('shortcuts');
    overrides[clash.id] = '';
  }
  if (res.accel === r.defaultAccel) delete overrides[r.id]; else overrides[r.id] = res.accel;
  ctx.set({ shortcutOverrides: overrides });
});

// ---------------------------------------------------------------- Advanced

registerSection({
  id: 'advanced', label: 'Advanced', icon: 'settings', order: 60,
  render(el) {
    const s = ctx.settings;
    const stats = ctx.snap.stats || {};
    const exts = s.extensions || [];
    const info = ctx.info;
    el.innerHTML = `
      ${group('Privacy & security', `
        ${row('Block ads and trackers', toggle('adblock', s.adblock !== false), 'Uses the Ghostery engine. Applies to every profile.')}
        ${row('Site permissions', button('reset-perms', 'Reset All…'), 'Camera, microphone, location, notifications and other choices you’ve made for sites.')}
      `)}
      ${group('Clear browsing data', `
        <div class="row checks">
          <label class="check"><input type="checkbox" id="cb-history" checked> History <span class="muted">(${stats.history ?? 0} pages)</span></label>
          <label class="check"><input type="checkbox" id="cb-cache" checked> Cached files</label>
          <label class="check"><input type="checkbox" id="cb-cookies"> Cookies and site data <span class="muted">(signs you out)</span></label>
          <div class="grow"></div>
          ${button('clear-data', 'Clear…', 'danger-outline')}
        </div>
        ${row('Archive', button('clear-archive', 'Clear Archive…', '', stats.archive ? '' : 'disabled'), `${stats.archive || 0} archived tabs. Open the archive from the Archive menu (${IS_MAC ? '⌥⌘A' : 'Ctrl+Alt+A'}).`)}
      `)}
      ${group('Extensions <span class="tag">Experimental</span>', `
        ${exts.map((p, i) => `
          <div class="row ext">
            <div class="ext-ic">${icon('puzzle', 16)}</div>
            <div class="row-text"><div class="row-label">${esc(p.split(/[\\/]/).filter(Boolean).at(-1))}</div><div class="row-desc mono">${esc(p)}</div></div>
            <div class="row-control"><button class="btn small" data-rm="${i}">Remove</button></div>
          </div>`).join('') || `<div class="empty">${icon('puzzle', 20)}<div>No extensions. Load an unpacked Chrome extension folder.</div></div>`}
        <div class="row add-row"><button class="btn" id="add-ext">${icon('plus', 14)} Load Unpacked…</button></div>
      `, 'Background and content scripts work; toolbar popups don’t yet.')}
      ${group('About', `
        <div class="row about">
          <svg width="44" height="44" viewBox="0 7 64 64" class="about-logo"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="currentColor"/></svg>
          <div class="row-text"><div class="row-label">Meridian ${esc(info.version)}</div><div class="row-desc">Chromium ${esc(info.chrome)} · Electron ${esc(info.electron)} · MIT licensed, not affiliated with The Browser Company.</div></div>
          <div class="row-control"><button class="btn small" id="open-repo">${icon('external', 13)} GitHub</button></div>
        </div>
      `)}`;
    $('#adblock', el).onchange = (e) => ctx.set({ adblock: e.target.checked });
    $('#reset-perms', el).onclick = async () => { if (await confirmBox('Reset all site permissions?', 'Sites will ask again next time.', 'Reset')) { await S.resetPermissions(); toast('Site permissions reset'); } };
    $('#clear-data', el).onclick = async () => {
      const what = { history: $('#cb-history', el).checked, cache: $('#cb-cache', el).checked, cookies: $('#cb-cookies', el).checked };
      if (!what.history && !what.cache && !what.cookies) return;
      if (!(await confirmBox('Clear browsing data?', 'This can’t be undone.', 'Clear', true))) return;
      await S.clearBrowsingData(what);
      toast('Browsing data cleared');
    };
    $('#clear-archive', el).onclick = async () => { if (await confirmBox('Clear the archive?', 'Archived tabs are gone for good.', 'Clear', true)) S.action('clear-archive'); };
    $('#add-ext', el).onclick = async () => { const p = await S.pickExtension(); if (p) { await ctx.set({ extensions: [...exts, p] }); toast('Extension loaded'); showSection('advanced'); } };
    $$('[data-rm]', el).forEach((b) => b.onclick = () => { const next = exts.filter((_, i) => i !== Number(b.dataset.rm)); ctx.set({ extensions: next }); toast('Removed — restart Meridian to fully unload it'); showSection('advanced'); });
    $('#open-repo', el).onclick = () => S.openUrl(info.repo);
  },
});

// ---------------------------------------------------------------- shell

function drawTabs() {
  $('#tabs').innerHTML = SECTIONS.map((s) => `<button class="tab ${s.id === ctx.section ? 'on' : ''}" data-id="${s.id}" role="tab">${icon(s.icon, 20)}<span>${esc(s.label)}</span></button>`).join('');
}

async function showSection(id) {
  if (!SECTIONS.some((s) => s.id === id)) id = 'general';
  const changed = ctx.section !== id;
  ctx.section = id;
  drawTabs();
  const el = $('#content');
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.section = id;
  const old = el.querySelector('.page');
  if (old?.dataset.q && !changed) page.dataset.q = old.dataset.q;
  try {
    await SECTIONS.find((s) => s.id === id).render(page, ctx);
  } catch (err) {
    // Never leave a blank page: say what broke.
    console.error(err);
    page.innerHTML = group('', row('This section couldn’t load', button('retry-section', 'Try Again'), esc(err?.message || String(err))));
    $('#retry-section', page).onclick = () => showSection(id);
  }
  el.replaceChildren(page);
  if (changed) { el.scrollTop = 0; page.classList.add('enter'); }
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}

// Re-render on outside changes, but never under the user's cursor in a text field.
let pendingRefresh = false;
function refresh() {
  const a = document.activeElement;
  if (recording || (a && a.matches('input.text, input#sc-search, textarea') && $('#content').contains(a)) || !$('#dialog-overlay').hidden) { pendingRefresh = true; return; }
  pendingRefresh = false;
  showSection(ctx.section);
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRefresh) refresh(); }, 0));

function applyAccent() {
  const sp = (ctx.snap.spaces || []).find((x) => x.id === ctx.snap.activeSpaceId) || ctx.snap.spaces?.[0];
  document.documentElement.style.setProperty('--accent', sp?.color || '#8a8fe0');
}

async function boot() {
  document.body.classList.add(IS_MAC ? 'plat-mac' : 'plat-other');
  ctx.info = await S.get();
  applyAccent();
  $('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) showSection(t.dataset.id); });
  $('#content').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showSection(g.dataset.goto); } });
  S.onState((st) => { ctx.info = { ...ctx.info, ...st }; applyAccent(); refresh(); });
  S.onSection((id) => showSection(id));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dialog-overlay').hidden) { $('#dialog-overlay').onmousedown?.({ target: $('#dialog-overlay') }); }
  });
  await showSection(decodeURIComponent(location.hash.slice(1)) || 'general');
}

window.addEventListener('DOMContentLoaded', boot);
