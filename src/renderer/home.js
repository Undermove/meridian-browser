// The home page (the empty state when no tab is open): what Meridian can do, a preset for each kind of
// person, the AI power-up ceremony, and small shortcut tips while people browse with the mouse.
'use strict';

const home = { built: false, aiReady: null, tipIndex: 0, tipTimer: null, mouse: { tab: 0, space: 0 }, taught: new Set() };

// Each card: an animated miniature, three things worth knowing, one real thing to try, and a preset.
const HOME_CARDS = [
  {
    id: 'everyday', title: 'For every day', tagline: 'Tabs that tidy themselves.', color: '#8a8fe0', demo: 'find',
    points: [['⌘T', 'Find any open tab by typing a few letters'], ['Today', 'Tabs you don’t pin are archived after a while'], ['⌘D', 'Pinned tabs always return to their home page']],
    tryLabel: 'Try ⌘T', tryCmd: 'command-bar',
  },
  {
    id: 'designer', title: 'For designers', tagline: 'Two pages at a glance.', color: '#c471f5', demo: 'split',
    points: [['^⇧=', 'Split view: two pages side by side'], ['Peek', 'Links from pinned tabs open in a preview'], ['Theme', 'Every space gets its own colour']],
    tryLabel: 'Pick a colour', tryCmd: 'edit-theme',
  },
  {
    id: 'manager', title: 'For managers', tagline: 'Work and life, kept apart.', color: '#4facfe', demo: 'spaces',
    points: [['^1…9', 'Spaces with their own logins: work and personal'], ['⌥⌘N', 'A little window for links from other apps'], ['⌥⌘A', 'Everything you closed, in the Archive']],
    tryLabel: 'Make a space', tryCmd: 'new-space',
  },
  {
    id: 'developer', title: 'For developers', tagline: 'Agents beside your site.', color: '#43cea2', demo: 'workbench',
    points: [['⇧⌘E', 'Workbench: files, editor and terminals'], ['MCP', 'Coding agents can read and drive the browser'], ['⇧⌘M', 'Mission Control shows every running agent']],
    tryLabel: 'Open Workbench', tryCmd: 'open-workbench',
  },
];

const HOME_TIPS = [
  ['⌘T', 'finds any open tab, in any space'],
  ['^⇥', 'jumps to the next tab without the mouse'],
  ['^1…9', 'switches straight to a space'],
  ['⇧⌘C', 'copies the address of the page'],
  ['⌘S', 'hides the sidebar for a full-width page'],
  ['⇧↵', 'in ⌘T opens a result next to the current page'],
  ['⌥⌘A', 'shows every tab you closed'],
  ['⌘D', 'pins the tab so it’s always there'],
];

// '⌘T' → ⌘ T keycaps (Ctrl T elsewhere); '^1…9' → ⌃ 1–9.
function kbdOf(k) {
  const parts = IS_MAC ? k.match(/[⌘⌥⇧^⌃↵⇥]|[^⌘⌥⇧^⌃↵⇥]+/g) || [k] : keys(k).split('+');
  return parts.map((x) => `<kbd>${esc(x === '^' ? '⌃' : x.replace('…', '–'))}</kbd>`).join('');
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The miniature in each card: a tiny window that acts out the feature on hover.
function demoHtml(kind) {
  const side = '<i class="hd-side"><b></b><b></b><b class="on"></b><b></b></i>';
  if (kind === 'find') return `<div class="hd hd-find">${side}<i class="hd-page"></i><i class="hd-bar"><i class="hd-q"></i><b></b><b class="hit"></b><b></b></i></div>`;
  if (kind === 'split') return `<div class="hd hd-split">${side}<i class="hd-page a"></i><i class="hd-page b"></i></div>`;
  if (kind === 'spaces') return `<div class="hd hd-spaces"><i class="hd-side s1"><b></b><b class="on"></b><b></b></i><i class="hd-side s2"><b class="on"></b><b></b></i><i class="hd-page"></i><i class="hd-dots"><b></b><b></b></i></div>`;
  return `<div class="hd hd-workbench">${side}<i class="hd-code"><b></b><b></b><b></b><b></b></i><i class="hd-page b"></i></div>`;
}

const GEM_SVG = (cls = '') => `<svg class="gem ${cls}" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="gem-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd6f5"/><stop offset="0.45" stop-color="#b48cff"/><stop offset="1" stop-color="#5a7bff"/></linearGradient></defs>
  <path d="M20 8h24l14 16-26 32L6 24z" fill="url(#gem-g)"/>
  <path d="M6 24h52M20 8l12 16 12-16M32 24v32" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M20 8l-14 16h14zM44 8l14 16H44z" fill="rgba(255,255,255,0.25)"/>
</svg>`;

function buildHome() {
  const more = $('#home-more');
  if (!more || EPHEMERAL) return;
  home.built = true;
  // The plain hint becomes a big search field that opens ⌘T.
  $('#empty-state .hint').outerHTML = `<button class="home-search" id="home-search"><span class="hs-ic">${icon('search', 18)}</span><span class="hs-text">Search, ask a question or open a site</span><span class="hs-keys">${kbdOf('⌘T')}</span></button>`;
  $('#empty-state .empty-act[data-cmd="command-bar"]')?.remove();
  $('#home-search').addEventListener('click', (e) => { rt.cmdFrom = e.currentTarget; openCommandBar('new'); });
  more.innerHTML = `
    <section class="home-section">
      <div class="home-head"><h2>What Meridian can do</h2><button class="home-link" id="home-compact">Show less</button></div>
      <div class="home-cards">
        ${HOME_CARDS.map((c, i) => `
        <article class="home-card" data-card="${c.id}" style="--c:${c.color};--i:${i}" tabindex="0">
          <div class="hc-demo">${demoHtml(c.demo)}</div>
          <div class="hc-body">
            <div class="hc-title">${esc(c.title)}</div>
            <div class="hc-tagline">${esc(c.tagline)}</div>
            <ul class="hc-points">${c.points.map(([k, t]) => `<li><span class="hc-k">${/^[⌘⌥⇧^]/.test(k) ? kbdOf(k) : `<em>${esc(k)}</em>`}</span><span>${esc(t)}</span></li>`).join('')}</ul>
            <div class="hc-actions">
              <button class="btn small accent" data-cmd="${c.tryCmd}">${esc(c.tryLabel)}</button>
              <button class="btn small ghost" data-preset="${c.id}">Set up for me</button>
            </div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="home-power" id="home-power" hidden>
      <div class="hp-gem">${GEM_SVG()}</div>
      <div class="hp-text">
        <div class="hp-title">Power up Meridian with AI</div>
        <div class="hp-sub">Answers right in ⌘T, help with any page, tabs that sort themselves. Bring your own Claude API key — or use a free local model.</div>
      </div>
      <div class="hp-actions">
        <button class="btn accent" id="hp-insert">Insert the gem</button>
        <button class="home-link" id="hp-local">Free and private option</button>
      </div>
    </section>
    <div class="home-tip" id="home-tip" aria-live="polite"></div>`;
  more.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) return openPreset(preset.dataset.preset);
    if (e.target.closest('#hp-insert')) return openPowerUp();
    if (e.target.closest('#hp-local')) return openSettings('ai');
    if (e.target.closest('#home-compact')) return setHomeCompact(true);
  });
  $('#empty-state').addEventListener('click', (e) => { if (e.target.closest('#home-expand')) setHomeCompact(false); });
  applyHomeCompact();
}

function setHomeCompact(on) {
  state.home = { ...(state.home || {}), compact: !!on };
  save();
  applyHomeCompact();
}

function applyHomeCompact() {
  const compact = !!state.home?.compact;
  $('#empty-state').classList.toggle('home-compact', compact);
  let link = $('#home-expand');
  if (compact && !link) {
    $('#empty-state .home-hero').insertAdjacentHTML('beforeend', '<button class="home-link" id="home-expand">What can Meridian do?</button>');
  } else if (!compact && link) link.remove();
}

// Runs whenever the home page is shown: greeting, tip, and whether to offer the AI power-up.
function refreshHome() {
  if (EPHEMERAL) return;
  if (!home.built) buildHome();
  const g = $('#empty-state .home-greet');
  if (g) { g.hidden = false; g.textContent = greeting(); }
  showHomeTip();
  aiIsReady().then((ready) => { const p = $('#home-power'); if (p) p.hidden = ready; });
}

async function aiIsReady() {
  try {
    if (await api.aiHasKey()) return true;
    if (typeof resolveAiProvider === 'function') { const p = await resolveAiProvider(); return !!p?.ready; }
  } catch {}
  return false;
}

function showHomeTip() {
  const el = $('#home-tip');
  if (!el) return;
  const [k, t] = HOME_TIPS[home.tipIndex % HOME_TIPS.length];
  el.innerHTML = `<span class="ht-label">Tip</span>${kbdOf(k)}<span>${esc(t)}</span>`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearInterval(home.tipTimer);
  home.tipTimer = setInterval(() => {
    if ($('#empty-state').hidden) return clearInterval(home.tipTimer);
    home.tipIndex++; showHomeTip();
  }, 7000);
}

function initHome() {
  if (EPHEMERAL) return;
  state.tips ||= {};
  refreshHome();
}

// ---------------------------------------------------------------- presets ("Set up for me")

async function openPreset(persona) {
  const card = HOME_CARDS.find((c) => c.id === persona);
  if (!card) return;
  const p = await api.setupPropose({ persona, useArc: false, useApps: false }).catch(() => null);
  if (!p) return toast('Couldn’t prepare the preset');
  const picks = { spaces: p.spaces.map(() => true), favorites: p.favorites.map(() => true) };
  const modeName = { developer: 'Developer', creative: 'Creative', everyday: 'Everyday' }[p.mode] || p.mode;
  showModal(`
    <div class="preset" style="--c:${esc(card.color)}">
      <div class="preset-demo">${demoHtml(card.demo)}</div>
      <h3>Set up Meridian ${esc(card.title.toLowerCase())}</h3>
      <p class="muted">Pick what to add. Nothing you have now is removed, and you can change all of it later.</p>
      <div class="preset-group"><div class="pg-label">Spaces</div>
        ${p.spaces.map((s, i) => `<label class="preset-chip"><input type="checkbox" data-kind="spaces" data-i="${i}" checked><span class="pc-em" style="--c:${esc(s.color)}">${esc(s.icon || '•')}</span>${esc(s.name)}</label>`).join('')}
      </div>
      <div class="preset-group"><div class="pg-label">Favorites</div>
        ${p.favorites.map((f, i) => `<label class="preset-chip"><input type="checkbox" data-kind="favorites" data-i="${i}" checked><span class="pc-fav">${esc(f.title[0])}</span>${esc(f.title)}</label>`).join('')}
      </div>
      <div class="preset-group"><div class="pg-label">Mode</div><span class="preset-mode">${esc(modeName)}</span><span class="muted small">${p.mode === 'developer' ? 'All tools, including the Workbench and Mission Control' : p.mode === 'creative' ? 'Spaces, split view and AI up front' : 'Just the essentials'}</span></div>
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="ok">Set up</button></div>
    </div>`, (m, close) => {
    m.addEventListener('change', (e) => { const cb = e.target.closest('input[data-kind]'); if (cb) picks[cb.dataset.kind][Number(cb.dataset.i)] = cb.checked; });
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      close();
      if (a === 'ok') { applyPreset(p, picks); celebrate(card.color); toast(`Meridian is set up ${card.title.toLowerCase()}`); }
    });
  });
}

// Additive: new spaces and favorites are added; a fresh, empty first space takes the first preset space.
function applyPreset(p, picks) {
  applySettingsPatch({ mode: p.mode });
  const chosen = p.spaces.filter((_, i) => picks.spaces[i]);
  const has = (name) => state.spaces.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const pristine = state.spaces.length === 1 && !state.spaces[0].pinned.length && !state.spaces[0].today.length;
  chosen.forEach((s, i) => {
    if (has(s.name)) return;
    if (i === 0 && pristine) return Object.assign(state.spaces[0], { name: s.name, icon: s.icon, color: s.color });
    state.spaces.push(newSpace(s.name, s.icon, s.color, space().profileId || 'default'));
  });
  const pid = space().profileId || 'default';
  const favs = (state.favorites[pid] ||= []);
  const urls = new Set(favs.map((t) => t.url));
  p.favorites.forEach((f, i) => { if (picks.favorites[i] && !urls.has(f.url)) favs.push({ id: uid(), type: 'tab', url: f.url, title: f.title }); });
  render(); save();
}

// A short burst of colour from the middle of the window.
function celebrate(color = 'var(--space)') {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'celebrate';
  for (let i = 0; i < 24; i++) {
    const s = document.createElement('i');
    const a = (i / 24) * Math.PI * 2, d = 120 + Math.random() * 140;
    s.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d}px;--c:${i % 3 ? color : '#ffd27a'};--r:${Math.random() * 360}deg`;
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1200);
}

// ---------------------------------------------------------------- the AI power-up ceremony

const POWERS = [
  ['search', 'Answers right in ⌘T', 'Type a question where you open tabs.'],
  ['sparkles', 'Help with any page', '⌘J summarises, explains and — if you allow it — acts for you.'],
  ['wand', 'Tabs that sort themselves', 'Tidy Today groups and renames your tabs.'],
  ['eye', 'Link previews', 'Hold Shift over a link to see what’s behind it.'],
];

function openPowerUp() {
  if (EPHEMERAL || $('#power')) return;
  const el = document.createElement('div');
  el.id = 'power';
  el.innerHTML = `
    <div class="pw-stage">
      <button class="pw-close" data-a="close" title="Close (Esc)">${icon('x', 16)}</button>
      <div class="pw-artifact">
        <svg class="pw-ring" viewBox="0 0 200 200" aria-hidden="true">
          <defs><linearGradient id="pw-rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd6f5"/><stop offset="0.5" stop-color="#b48cff"/><stop offset="1" stop-color="#5a7bff"/></linearGradient></defs>
          <path class="pw-arc" d="M20 150 A80 80 0 0 1 180 150" fill="none" stroke-width="16" stroke-linecap="round"/>
        </svg>
        <div class="pw-socket" id="pw-socket"></div>
        <div class="pw-orbit">${'<i></i>'.repeat(10)}</div>
      </div>
      <div class="pw-copy">
        <h2 id="pw-title">Give Meridian a gem</h2>
        <p class="pw-lead" id="pw-lead">A Claude API key is the gem. Set it into Meridian and the browser starts answering questions, explaining pages and tidying your tabs.</p>
      </div>
      <form class="pw-form" id="pw-form" autocomplete="off">
        <div class="pw-gemslot">${GEM_SVG('pw-gem')}</div>
        <div class="pw-field">
          <input id="pw-key" type="password" spellcheck="false" placeholder="Paste your key: sk-ant-…" aria-label="Claude API key">
          <button type="submit" class="btn accent" id="pw-go">Set the gem</button>
        </div>
        <div class="pw-error" id="pw-error" role="alert"></div>
        <div class="pw-help">
          <button type="button" class="home-link" data-a="console">Get a key in the Anthropic Console</button>
          <span>·</span>
          <button type="button" class="home-link" data-a="local">Rather free and private? Use a local model</button>
        </div>
        <p class="pw-fine">Pay as you go on your own Anthropic account: a question in ⌘T costs a fraction of a cent. The key is encrypted with your computer’s keychain and only ever sent to Anthropic.</p>
      </form>
      <div class="pw-powers" id="pw-powers" hidden>
        ${POWERS.map(([ic, t, d], i) => `<div class="pw-power" style="--i:${i}"><span class="pwp-ic">${icon(ic, 18)}</span><span><b>${esc(t)}</b><small>${esc(d)}</small></span></div>`).join('')}
        <div class="pw-done"><button class="btn accent" data-a="try">Ask something in ⌘T</button><button class="btn" data-a="close">Done</button></div>
      </div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const input = $('#pw-key', el);
  setTimeout(() => input.focus(), 250);
  const close = () => { el.classList.remove('open'); el.classList.add('closing'); document.removeEventListener('keydown', onKey, true); setTimeout(() => el.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => {
    el.classList.toggle('has-key', input.value.trim().length > 0);
    $('#pw-error', el).textContent = '';
    el.classList.remove('cracked');
  });
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (e.target === el) return close();
    if (!a) return;
    if (a === 'close') return close();
    if (a === 'console') { openTab('https://console.anthropic.com/settings/keys', { background: true }); toast('Opened the Anthropic Console in a new tab'); return; }
    if (a === 'local') { close(); return openSettings('ai'); }
    if (a === 'try') {
      close();
      setTimeout(() => { openCommandBar('new'); const i = $('#cmd-input'); i.value = 'What can you help me with?'; updateCommandResults(); }, 280);
    }
  });
  $('#pw-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key || el.classList.contains('checking')) return;
    el.classList.add('checking');
    $('#pw-go', el).disabled = true;
    $('#pw-lead', el).textContent = 'Checking the gem with Anthropic…';
    const r = await api.aiConnectKey(key).catch((err) => ({ ok: false, error: err.message }));
    el.classList.remove('checking');
    $('#pw-go', el).disabled = false;
    if (!r?.ok) {
      el.classList.add('cracked');
      $('#pw-error', el).textContent = r?.error || 'That didn’t work.';
      $('#pw-lead', el).textContent = 'This gem didn’t fit. Check the key and try again.';
      return;
    }
    input.value = '';
    applySettingsPatch({ aiProvider: 'api' });
    if (typeof resolveAiProvider === 'function' && typeof ai !== 'undefined') resolveAiProvider().then((p) => { ai.provider = p; }).catch(() => {});
    await setGem(el);
    refreshHome();
  });
}

// The gem flies into the socket, the arc lights up, and the new powers appear one by one.
async function setGem(el) {
  const gem = $('.pw-gem', el), socket = $('#pw-socket', el);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    const a = gem.getBoundingClientRect(), b = socket.getBoundingClientRect();
    await gem.animate([
      { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
      { transform: `translate(${(b.left + b.width / 2 - (a.left + a.width / 2)) * 0.6}px, ${(b.top - a.top) * 0.55 - 40}px) scale(1.25) rotate(-12deg)`, offset: 0.55 },
      { transform: `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${b.top + b.height / 2 - (a.top + a.height / 2)}px) scale(0.62) rotate(0deg)` },
    ], { duration: 820, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'forwards' }).finished.catch(() => {});
  }
  socket.innerHTML = GEM_SVG('pw-set');
  el.classList.add('powered');
  $('#pw-title', el).textContent = 'Meridian is powered up';
  $('#pw-lead', el).textContent = 'Here’s what you can do now:';
  $('#pw-form', el).hidden = true;
  $('#pw-powers', el).hidden = false;
  celebrate('#b48cff');
}

// ---------------------------------------------------------------- shortcut tips while browsing

// A tip at most a couple of times ever, and once per session.
function tip(id, html, { max = 2 } = {}) {
  if (EPHEMERAL || home.taught.has(id)) return false;
  state.tips ||= {};
  if ((state.tips[id] || 0) >= max) return false;
  home.taught.add(id);
  state.tips[id] = (state.tips[id] || 0) + 1;
  save();
  const el = document.createElement('div');
  el.className = 'tip-toast';
  el.innerHTML = `<span class="tt-ic">${icon('keyboard', 16)}</span><span class="tt-text">${html}</span><button class="tt-x" title="Got it">${icon('x', 12)}</button>`;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const hide = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  el.querySelector('.tt-x').onclick = hide;
  setTimeout(hide, 7000);
  return true;
}

// Switching with the mouse a few times in a row earns a hint about the keys for it.
function noteMouseSwitch(kind) {
  home.mouse[kind] = (home.mouse[kind] || 0) + 1;
  if (kind === 'tab' && home.mouse.tab === 4) tip('tab-switch', `Switch tabs without the mouse: ${kbdOf('^⇥')} next tab, ${kbdOf('⌘T')} find any tab by name`);
  if (kind === 'space' && home.mouse.space === 3) tip('space-switch', `${kbdOf('^1')} … ${kbdOf('^9')} jump straight to a space`);
}

// Ran a command from ⌘T that has its own shortcut: mention the shortcut, a couple of times per command.
function teachShortcut(c) {
  if (!c.keys) return;
  setTimeout(() => tip(`cmd-${c.id}`, `Next time: ${kbdOf(c.keys)} for ${esc(c.label)}`), 400);
}
