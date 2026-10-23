/* Meridian — welcome tour (full window, in the spirit of a new Mac's first launch).
 *
 * Meridian replaces Arc first, so the tour is about moving in — no AI here (that's offered days later,
 * once the person has settled in: maybeOfferAi in app.js).
 *   Arc found:    hello → Bring everything from Arc → Use Meridian for links → All set
 *   no Arc:       hello → Make it yours (a setup from the apps on this computer, worked out locally)
 *                 → Here's your Meridian → Use Meridian for links → All set
 * Re-runnable from Help → Welcome Tour and Settings → General. Completion is saved as state.onboarded.
 * Loaded after app.js / panels.js / ai.js and shares their globals.
 */

const ob = { el: null, step: 0, steps: [], agentsPromise: null, arc: null, arcLogins: false, agents: [], hasKey: false, provider: null, proposal: null, picks: null, poll: null, helloTimer: null };

const HELLOS = ['hello', 'привет', 'hola', 'bonjour', 'hallo', 'ciao', 'olá', 'გამარჯობა', 'merhaba', 'hej', 'こんにちは', '你好'];
const AGENT_COLORS = { claude: '#d97757', codex: '#10a37f', gemini: '#4285f4', copilot: '#8957e5', cursor: '#1c1c1c', opencode: '#4b5563', qwen: '#615ced', amp: '#f34e3f', goose: '#222', droid: '#ff6b00', ollama: '#333', lmstudio: '#4f46e5' };

function obSteps() {
  return ['hello', ...(ob.arc && !ob.fresh ? ['arc'] : ['tailor', 'preview']), ...(ob.isDefault ? [] : ['default']), 'done'];
}

async function startOnboarding() {
  if (EPHEMERAL || ob.el) return;
  closePanels?.();
  Object.assign(ob, { step: 0, proposal: null, picks: null, applying: false });
  ob.arc = await api.arcPreview().catch(() => null);
  if (ob.arc?.error || !ob.arc?.spaces) ob.arc = null;
  ob.arcLogins = !!(ob.arc && await api.arcLoginsAvailable().catch(() => false));
  ob.isDefault = await api.isDefaultBrowser().catch(() => false);
  ob.fresh = false; ob.withLogins = true; ob.imported = null;
  ob.steps = obSteps();
  const el = document.createElement('div');
  el.id = 'onboarding';
  el.innerHTML = `
    <div class="ob-bg"><i class="b1"></i><i class="b2"></i><i class="b3"></i></div>
    <div class="ob-top"><div class="grow"></div><button class="ob-skip" data-ob="skip">Skip</button></div>
    <div class="ob-stage"></div>
    <div class="ob-foot">
      <button class="ob-btn ghost" data-ob="back">${icon('arrowLeft', 16)}</button>
      <div class="ob-dots"></div>
      <button class="ob-btn primary" data-ob="next">Continue</button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('onboarding');
  ob.el = el;
  el.addEventListener('click', onObClick);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('input, button, textarea')) { e.preventDefault(); obNext(); }
  });
  showObStep(0);
}

function finishOnboarding() {
  state.onboarded = true;
  state.onboardedAt ||= Date.now();
  if (!state.settings.mode) state.settings.mode = 'everyday';
  save();
  const el = ob.el;
  ob.el = null;
  clearInterval(ob.poll); clearInterval(ob.helloTimer);
  document.body.classList.remove('onboarding');
  render();
  if (!el) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 420);
}

// While the tour is open, app shortcuts don't act behind it.
function onboardingIntercept() { return !!ob.el; }

function onObClick(e) {
  const a = e.target.closest('[data-ob]')?.dataset.ob;
  if (!a) return;
  if (a === 'skip') return finishOnboarding();
  if (a === 'back') return showObStep(Math.max(0, ob.step - 1), -1);
  if (a === 'next') return obNext();
  if (a.startsWith('goto:')) { const i = Number(a.slice(5)); if (i <= ob.step) showObStep(i, -1); }
}

function obNext() {
  const name = ob.steps[ob.step];
  if (OB_STEPS[name].next) return OB_STEPS[name].next();
  if (ob.step >= ob.steps.length - 1) return finishOnboarding();
  showObStep(ob.step + 1, 1);
}

async function showObStep(i, dir = 1) {
  ob.step = i;
  clearInterval(ob.poll); clearInterval(ob.helloTimer);
  const name = ob.steps[i];
  const def = OB_STEPS[name];
  const stage = $('.ob-stage', ob.el);
  const page = document.createElement('div');
  page.className = `ob-page ob-step-${name}`;
  // A step that needs a moment to prepare shows it right away (a dead-looking button reads as broken).
  const nextBtn = $('[data-ob="next"]', ob.el);
  const slow = setTimeout(() => { nextBtn.disabled = true; nextBtn.classList.add('busy'); }, 120);
  try { page.innerHTML = await def.html(); } finally { clearTimeout(slow); nextBtn.classList.remove('busy'); nextBtn.disabled = false; }
  if (!ob.el || ob.steps[ob.step] !== name) return;
  const old = stage.firstElementChild;
  if (old) old.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: `translateX(${-dir * 40}px) scale(0.98)`, filter: 'blur(6px)' }], { duration: 260, easing: 'ease-in', fill: 'forwards' }).onfinish = () => old.remove();
  stage.appendChild(page);
  page.animate([{ opacity: 0, transform: `translateX(${dir * 60}px) scale(0.98)`, filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 560, delay: old ? 140 : 0, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' });
  def.bind?.(page);
  $('.ob-dots', ob.el).innerHTML = ob.steps.map((s, j) => `<button class="ob-dot ${j === i ? 'on' : ''} ${j < i ? 'past' : ''}" data-ob="goto:${j}" aria-label="${esc(s)}"></button>`).join('');
  ob.el.dataset.step = name;
  $('[data-ob="back"]', ob.el).style.visibility = i === 0 || name === 'done' ? 'hidden' : 'visible';
  $('.ob-skip', ob.el).style.visibility = name === 'done' ? 'hidden' : 'visible';
  setObNext(def.cta ? def.cta() : 'Continue');
  $('[data-ob="next"]', ob.el).classList.toggle('round', name === 'hello');
  localizeKeys(ob.el);
}

function setObNext(label, { disabled = false, hidden = false } = {}) {
  const next = $('[data-ob="next"]', ob.el);
  if (!next) return;
  next.innerHTML = label;
  next.disabled = disabled;
  next.style.visibility = hidden ? 'hidden' : 'visible';
  setTimeout(() => { if (!next.disabled) next.focus(); }, 60);
}

const LOGO_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 7 64 64" class="ob-logo"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="50" r="4.5" fill="currentColor"/></svg>`;
const agentMark = (a, size = 'big') => `<span class="ob-am ${size}" style="--c:${AGENT_COLORS[a.id] || '#777'}">${a.id === 'api' ? icon('sparkles', size === 'big' ? 30 : 15) : esc(a.label[0])}</span>`;
const tile = (title, color) => `<span class="ob-fav" style="--c:${esc(color)}">${esc(title[0])}</span>`;
const FAV_COLORS = { Gmail: '#ea4335', 'Google Calendar': '#4285f4', 'Google Drive': '#0f9d58', 'Google Docs': '#4285f4', 'Google Sheets': '#0f9d58', Notion: '#111', Slack: '#4a154b', Linear: '#5e6ad2', Figma: '#a259ff', GitHub: '#24292f', GitLab: '#fc6d26', Telegram: '#2aabee', WhatsApp: '#25d366', YouTube: '#ff0000', Spotify: '#1db954', Claude: '#d97757', ChatGPT: '#10a37f', Dribbble: '#ea4c89', Pinterest: '#e60023', Outlook: '#0078d4', 'Microsoft Teams': '#6264a7', Discord: '#5865f2', X: '#111', Threads: '#111', Reddit: '#ff4500', LinkedIn: '#0a66c2' };

const OB_STEPS = {
  // ------------------------------------------------------------ hello, in many languages
  hello: {
    html: () => `
      <div class="ob-hello">
        <div class="ob-hello-word" aria-live="polite"><span>${HELLOS[0]}</span></div>
        <div class="ob-hello-mark">${LOGO_SVG(26)}<span>Meridian</span></div>
      </div>`,
    cta: () => `${icon('arrowRight', 18)}`,
    bind(page) {
      let i = 0;
      ob.helloTimer = setInterval(() => {
        const box = $('.ob-hello-word', page);
        if (!box) return clearInterval(ob.helloTimer);
        i = (i + 1) % HELLOS.length;
        const s = document.createElement('span');
        s.textContent = HELLOS[i];
        const old = box.firstElementChild;
        old?.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(10px)' }], { duration: 500, fill: 'forwards' }).finished.then(() => old.remove());
        box.appendChild(s);
      }, 2600);
    },
  },

  // ------------------------------------------------------------ moving in from Arc
  arc: {
    html: () => {
      const a = ob.arc;
      const n = (x, one, many) => `${x.toLocaleString()} ${x === 1 ? one : many}`;
      return `
        <h2>Bring everything from Arc</h2>
        <p class="ob-whisper top">Your spaces, pinned tabs and favorites move over as they are. Arc stays untouched.</p>
        <div class="ob-arc-move">
          <div class="ob-arc-stats"><b>${n(a.spaces, 'space', 'spaces')}</b><b>${n(a.pinned + a.today, 'tab', 'tabs')}</b><b>${n(a.favorites, 'favorite', 'favorites')}</b></div>
          <div class="ob-arc-spaces">${a.names.map((sp) => `<span class="ob-space" style="--c:${esc(sp.color)}">${sp.icon ? `<em>${esc(sp.icon)}</em>` : '<i></i>'}${esc(sp.name)}</span>`).join('')}</div>
          ${ob.arcLogins ? `<button class="ob-opt ${ob.withLogins ? 'on' : ''}" data-opt="logins"><span class="ob-opt-ic">${icon('lock', 16)}</span><span><b>Stay signed in to your sites</b><em>So you don’t have to log in everywhere again</em></span><span class="ob-tick">${icon('check', 13)}</span></button>` : ''}
        </div>
        <button class="ob-link" data-ob-fresh>Start fresh instead</button>`;
    },
    cta: () => 'Bring everything',
    bind(page) {
      page.addEventListener('click', (e) => {
        const o = e.target.closest('[data-opt="logins"]');
        if (o) { ob.withLogins = !ob.withLogins; o.classList.toggle('on', ob.withLogins); return; }
        if (e.target.closest('[data-ob-fresh]')) { ob.fresh = true; ob.steps = obSteps(); showObStep(ob.step, 1); }
      });
    },
    async next() {
      if (ob.applying) return;
      ob.applying = true;
      setObNext('Moving in…', { disabled: true });
      try {
        ob.imported = await importArc({ quiet: true });
        if (ob.imported && ob.withLogins && ob.arcLogins) {
          const l = await api.importArcLogins().catch(() => null);
          if (l?.ok && l.total) toast(`You’re still signed in to your sites (${l.total.toLocaleString()} logins brought over)`, { timeout: 5000 });
        }
      } finally { ob.applying = false; }
      if (ob.el) showObStep(ob.step + 1, 1);
    },
  },

  // ------------------------------------------------------------ a quick look, then the AI proposes a setup
  tailor: {
    html: () => `
      <h2>Let’s make it yours</h2>
      <div class="ob-tailor">
        <div class="ob-consent">
          <button class="ob-pill on" data-c="apps">${icon('grid', 15)} Look at the apps I use</button>
        </div>
        <div class="ob-think" hidden><div class="ob-orb"><i></i><i></i><i></i></div><ul class="ob-lines"></ul></div>
      </div>
      <p class="ob-whisper">Meridian suggests spaces and favorites that fit you. This happens on your computer — nothing is sent anywhere, and nothing changes until you say so.</p>`,
    cta: () => `${icon('sparkles', 16)} Suggest a setup`,
    bind(page) {
      $('.ob-consent', page).onclick = (e) => { const b = e.target.closest('.ob-pill'); if (b) b.classList.toggle('on'); };
    },
    async next() {
      const page = $('.ob-step-tailor', ob.el);
      if (!page || page.dataset.busy) return;
      page.dataset.busy = '1';
      const useApps = !!$('[data-c="apps"].on', page);
      $('.ob-consent', page).hidden = true;
      $('.ob-think', page).hidden = false;
      setObNext('One moment…', { disabled: true });
      const lines = $('.ob-lines', page);
      const line = (text) => { const li = document.createElement('li'); li.textContent = text; lines.appendChild(li); li.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: 'ease-out' }); };
      if (useApps) line('Looking at your apps…');
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      // No AI here: simple rules on this computer (src/ai/setup-profile.js).
      const proposal = await api.setupPropose({ provider: null, useApps, useArc: false }).catch(() => null);
      await minDelay;
      if (!ob.el || ob.steps[ob.step] !== 'tailor') return;
      if (!proposal) { delete page.dataset.busy; toast('Something went wrong. Try again or skip.'); return showObStep(ob.step, 0); }
      if (proposal.seen?.apps?.length) line(`Found ${proposal.seen.apps.slice(0, 4).join(', ')}${proposal.seen.apps.length > 4 ? '…' : ''}`);
      await new Promise((r) => setTimeout(r, 600));
      line(proposal.title);
      lines.lastChild?.classList.add('final');
      ob.proposal = proposal;
      ob.picks = { spaces: proposal.spaces.map(() => true), favorites: proposal.favorites.map(() => true), agents: false };
      await new Promise((r) => setTimeout(r, 1000));
      if (ob.el && ob.steps[ob.step] === 'tailor') showObStep(ob.step + 1, 1);
    },
  },

  // ------------------------------------------------------------ the proposal, as a live preview
  preview: {
    html: () => {
      const p = ob.proposal || { title: 'Your Meridian', spaces: [{ name: 'Personal', icon: '🏠', color: space().color }], favorites: [], mode: 'everyday', color: space().color, source: 'rules' };
      ob.proposal = p;
      ob.picks ||= { spaces: p.spaces.map(() => true), favorites: p.favorites.map(() => true), agents: false };
      const k = ob.picks;
      const modeLabel = { developer: 'Developer tools', creative: 'AI chat', everyday: 'Everyday' }[p.mode];
      const sp0 = p.spaces[0] || {};
      return `
        <div class="ob-preview-title"><span class="ob-persona">${p.source === 'ai' ? icon('sparkles', 14) : ''}${esc(p.title)}</span><h2>Here’s your Meridian</h2></div>
        <div class="ob-preview">
          <div class="ob-pv-window" style="--a:${esc(sp0.color || p.color)};--b:${esc(p.color)}">
            <div class="ob-pv-side">
              <div class="ob-pv-url"></div>
              <div class="ob-pv-favs">${p.favorites.map((f, i) => `<button class="ob-pv-fav ${k.favorites[i] ? '' : 'off'}" data-fav="${i}" title="${esc(f.title)}">${tile(f.title, FAV_COLORS[f.title] || p.color)}</button>`).join('')}</div>
              <div class="ob-pv-spaces">${p.spaces.map((s, i) => `<button class="ob-pv-space ${k.spaces[i] ? '' : 'off'}" data-space="${i}" style="--c:${esc(s.color)}"><em>${esc(s.icon)}</em>${esc(s.name)}</button>`).join('')}</div>
              <div class="ob-pv-rows"><i></i><i></i><i class="s"></i></div>
            </div>
            <div class="ob-pv-page"><div class="ob-pv-chip">${icon(p.mode === 'developer' ? 'code' : p.mode === 'creative' ? 'sparkles' : 'globe', 14)} ${esc(modeLabel)}</div><i class="w60"></i><i></i><i class="w80"></i></div>
          </div>
          <div class="ob-pv-opts">
            ${p.mode === 'developer' ? `<button class="ob-opt ${k.agents ? 'on' : ''}" data-opt="agents"><span class="ob-opt-ic">${icon('terminal', 16)}</span><span><b>Let coding agents use the browser</b><em>For developers. They ask before every action.</em></span><span class="ob-tick">${icon('check', 13)}</span></button>` : ''}
          </div>
        </div>
        <p class="ob-whisper">Tap anything to leave it out.</p>`;
    },
    cta: () => 'Looks great',
    bind(page) {
      page.addEventListener('click', (e) => {
        const k = ob.picks;
        const f = e.target.closest('[data-fav]'); if (f) { const i = +f.dataset.fav; k.favorites[i] = !k.favorites[i]; f.classList.toggle('off', !k.favorites[i]); return; }
        const s = e.target.closest('[data-space]'); if (s) { const i = +s.dataset.space; k.spaces[i] = !k.spaces[i]; s.classList.toggle('off', !k.spaces[i]); return; }
        const o = e.target.closest('[data-opt]');
        if (o) { k[o.dataset.opt] = !k[o.dataset.opt]; o.classList.toggle('on', k[o.dataset.opt]); }
      });
    },
    async next() {
      if (ob.applying) return; // a second click or Enter while applying would import Arc twice
      ob.applying = true;
      setObNext('Setting up…', { disabled: true });
      try { await applyProposal(); } finally { ob.applying = false; }
      if (ob.el) showObStep(ob.step + 1, 1);
    },
  },

  // ------------------------------------------------------------ links from other apps
  default: {
    html: () => `
      <div class="ob-hero">
        <div class="ob-mark">${icon('link', 46)}</div>
        <h2>Open your links in Meridian?</h2>
        <p class="ob-whisper">Links from Mail, Slack, Notion and other apps will open here instead of your old browser. You can change this any time.</p>
        <button class="ob-btn primary big ob-default-btn" id="ob-default">${icon('check', 16)} Yes, use Meridian</button>
      </div>`,
    cta: () => 'Not now',
    bind(page) {
      $('#ob-default', page).addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const r = await setDefaultBrowser();
        if (r?.cancelled) { e.currentTarget.disabled = false; return; }
        if (ob.el) showObStep(ob.step + 1, 1);
      });
    },
  },

  // ------------------------------------------------------------ done
  done: {
    html: () => `
        <div class="ob-hero">
          <div class="ob-mark done">${icon('check', 54)}</div>
          <h1>You’re all set</h1>
          <p class="ob-whisper">Press <kbd>⌘</kbd><kbd>T</kbd> to open a new tab or find anything you had open.</p>
        </div>`,
    cta: () => 'Start browsing',
    bind(page) {
      $('.ob-mark', page).animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)' }], { duration: 700, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    },
  },
};

// Make the picks real: mode, AI, spaces (or Arc), favorites, colour.
async function applyProposal() {
  const p = ob.proposal, k = ob.picks;
  if (!p) return;
  const patch = { mode: p.mode };
  if (k.agents) patch.agentAccess = 'ask';
  applySettingsPatch(patch);
  {
    const chosen = p.spaces.filter((_, i) => k.spaces[i]);
    const pristine = state.spaces.length === 1 && !state.spaces[0].pinned.length && !state.spaces[0].today.length;
    if (chosen.length) {
      if (pristine) Object.assign(state.spaces[0], { name: chosen[0].name, icon: chosen[0].icon, color: chosen[0].color });
      for (const s of chosen.slice(pristine ? 1 : 0)) state.spaces.push(newSpace(s.name, s.icon, s.color, state.spaces[0].profileId || 'default'));
    }
  }
  const pid = space().profileId || 'default';
  const favs = (state.favorites[pid] ||= []);
  const have = new Set(favs.map((t) => t.url));
  for (const [i, f] of p.favorites.entries()) if (k.favorites[i] && !have.has(f.url)) favs.push({ id: uid(), type: 'tab', url: f.url, title: f.title });
  render(); save();
}
