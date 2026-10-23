/* Meridian — welcome tour (full window, in the spirit of a new Mac's first launch).
 *
 * hello → Your AI → Make it yours → Here's your Meridian → All set.
 * Almost no reading: the person connects the AI they already use, allows a quick look at their apps
 * (and Arc), and their AI proposes a setup — mode, spaces, favorites, colour — that they tick and apply.
 * Without an AI, simple rules propose the same kind of setup (src/ai/setup-profile.js, in main).
 * Re-runnable from Help → Welcome Tour and Settings → General. Completion is saved as state.onboarded.
 * Loaded after app.js / panels.js / ai.js and shares their globals.
 */

const ob = { el: null, step: 0, steps: [], agentsPromise: null, arc: null, arcLogins: false, agents: [], hasKey: false, provider: null, proposal: null, picks: null, poll: null, helloTimer: null };

const HELLOS = ['hello', 'привет', 'hola', 'bonjour', 'hallo', 'ciao', 'olá', 'გამარჯობა', 'merhaba', 'hej', 'こんにちは', '你好'];
const AGENT_COLORS = { claude: '#d97757', codex: '#10a37f', gemini: '#4285f4', copilot: '#8957e5', cursor: '#1c1c1c', opencode: '#4b5563', qwen: '#615ced', amp: '#f34e3f', goose: '#222', droid: '#ff6b00', ollama: '#333', lmstudio: '#4f46e5' };

function obSteps() { return ['hello', 'ai', 'tailor', 'preview', 'done']; }

async function startOnboarding() {
  if (EPHEMERAL || ob.el) return;
  closePanels?.();
  Object.assign(ob, { step: 0, proposal: null, picks: null, applying: false });
  // Finding agents asks each CLI whether it's signed in (a few seconds the first time): start now, on hello.
  ob.agentsPromise = api.agentsList(true).catch(() => []);
  ob.arc = await api.arcPreview().catch(() => null);
  if (ob.arc?.error || !ob.arc?.spaces) ob.arc = null;
  ob.arcLogins = !!(ob.arc && await api.arcLoginsAvailable().catch(() => false));
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

  // ------------------------------------------------------------ connect the AI they already use
  ai: {
    async html() {
      const [agents, hasKey] = await Promise.all([ob.agentsPromise || api.agentsList(true).catch(() => []), api.aiHasKey().catch(() => false)]);
      ob.agentsPromise = null; // a revisit (after signing in) checks again
      ob.agents = agents; ob.hasKey = hasKey;
      const ready = agents.filter((a) => a.installed && a.loggedIn !== false);
      const p = pickAiProvider(agents, hasKey);
      ob.provider = p.ready ? p.id : null;
      if (p.ready) {
        const main = p.id === 'api' ? { id: 'api', label: 'Claude' } : agents.find((a) => a.id === p.id);
        const others = ready.filter((a) => a.id !== main.id);
        return `
          <h2>Your AI is here</h2>
          <div class="ob-ai-hero">
            ${agentMark(main)}
            <div class="ob-ai-name"><b>${esc(p.id === 'api' ? 'Claude API' : main.label)}</b><span class="ob-ready">${icon('check', 14)} Ready</span></div>
          </div>
          ${others.length ? `<div class="ob-ai-others">${others.map((a) => `<button class="ob-chip ob-ai-alt" data-use="${a.id}">${agentMark(a, 'small')} ${esc(a.label)}</button>`).join('')}</div>` : ''}
          <p class="ob-whisper">Meridian uses it to answer, explain and set things up. No extra subscription.</p>`;
      }
      const signin = agents.filter((a) => a.installed && a.loggedIn === false);
      const offer = signin.length ? signin : ['claude', 'codex', 'gemini'].map((id) => agents.find((a) => a.id === id)).filter(Boolean);
      return `
        <h2>Bring your AI</h2>
        <p class="ob-whisper top">Use the one you already pay for — Claude, ChatGPT or Gemini.</p>
        <div class="ob-ai-grid">${offer.map((a) => `
          <div class="ob-ai-card">
            ${agentMark(a)}
            <b>${esc(a.label)}</b>
            <span>${esc(a.vendor)}</span>
            ${a.installed ? `<button class="ob-btn small primary" data-setup="login" data-id="${a.id}">Sign in</button>`
              : a.install?.cmd ? `<button class="ob-btn small" data-setup="install" data-id="${a.id}">Get it</button>` : `<span class="ob-tag">needs ${esc(a.install?.missing || 'setup')}</span>`}
          </div>`).join('')}
        </div>`;
    },
    cta: () => (ob.provider ? 'Continue' : 'Later'),
    bind(page) {
      page.addEventListener('click', async (e) => {
        const alt = e.target.closest('[data-use]');
        if (alt) { applySettingsPatch({ aiProvider: alt.dataset.use }); return showObStep(ob.step, 0); }
        const b = e.target.closest('[data-setup]');
        if (!b) return;
        const r = await api.agentsSetup(b.dataset.id, b.dataset.setup).catch((err) => ({ ok: false, error: err.message }));
        if (r.cancelled) return;
        if (!r.ok) return toast(r.error || 'Couldn’t start setup', { timeout: 6000 });
        b.disabled = true; b.textContent = b.dataset.setup === 'install' ? 'Installing…' : 'Signing in…';
        const before = JSON.stringify(ob.agents.map((a) => [a.id, a.installed, a.loggedIn]));
        const start = Date.now();
        ob.poll = setInterval(async () => {
          if (!ob.el || ob.steps[ob.step] !== 'ai' || Date.now() - start > 5 * 60_000) return clearInterval(ob.poll);
          const now = await api.agentsList(true).catch(() => []);
          if (JSON.stringify(now.map((a) => [a.id, a.installed, a.loggedIn])) !== before) { clearInterval(ob.poll); aiAgents.at = 0; showObStep(ob.step, 0); }
        }, 3000);
      });
    },
  },

  // ------------------------------------------------------------ a quick look, then the AI proposes a setup
  tailor: {
    html: () => `
      <h2>Let’s make it yours</h2>
      <div class="ob-tailor">
        <div class="ob-consent">
          <button class="ob-pill on" data-c="apps">${icon('grid', 15)} Look at my apps</button>
          ${ob.arc ? `<button class="ob-pill on" data-c="arc">${icon('download', 15)} Look at my Arc</button>` : ''}
        </div>
        <input class="ob-about" id="ob-about" maxlength="200" placeholder="Anything about you? e.g. “product designer at a startup” (optional)" spellcheck="false">
        <div class="ob-think" hidden><div class="ob-orb"><i></i><i></i><i></i></div><ul class="ob-lines"></ul></div>
      </div>
      <p class="ob-whisper">${ob.provider ? `Only app names and space names go to ${esc(ob.provider === 'api' ? 'Claude' : (ob.agents.find((a) => a.id === ob.provider)?.label || 'your AI'))}. Nothing is changed until you say so.` : 'Nothing leaves your computer. Nothing is changed until you say so.'}</p>`,
    cta: () => `${icon('sparkles', 16)} Make it mine`,
    bind(page) {
      $('.ob-consent', page).onclick = (e) => { const b = e.target.closest('.ob-pill'); if (b) b.classList.toggle('on'); };
      $('#ob-about', page).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); obNext(); } });
    },
    async next() {
      const page = $('.ob-step-tailor', ob.el);
      if (!page || page.dataset.busy) return;
      page.dataset.busy = '1';
      const useApps = !!$('[data-c="apps"].on', page), useArc = !!$('[data-c="arc"].on', page);
      const about = $('#ob-about', page).value.trim();
      $('.ob-consent', page).hidden = true; $('#ob-about', page).hidden = true;
      const think = $('.ob-think', page);
      think.hidden = false;
      setObNext('Thinking…', { disabled: true });
      const lines = $('.ob-lines', page);
      const line = (text) => { const li = document.createElement('li'); li.textContent = text; lines.appendChild(li); li.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: 'ease-out' }); };
      if (useApps) line('Looking at your apps…');
      if (useArc) setTimeout(() => line('Reading your Arc spaces…'), 500);
      if (about) setTimeout(() => line('Reading what you told me…'), 900);
      const minDelay = new Promise((r) => setTimeout(r, 1800));
      const proposal = await api.setupPropose({ provider: ob.provider, useApps, useArc, about }).catch(() => null);
      await minDelay;
      if (!ob.el || ob.steps[ob.step] !== 'tailor') return;
      if (!proposal) { delete page.dataset.busy; toast('Couldn’t make a proposal. Try again or skip.'); return showObStep(ob.step, 0); }
      if (proposal.seen?.apps?.length) line(`Found ${proposal.seen.apps.slice(0, 4).join(', ')}${proposal.seen.apps.length > 4 ? '…' : ''}`);
      await new Promise((r) => setTimeout(r, 700));
      line(proposal.title);
      lines.lastChild?.classList.add('final');
      ob.proposal = proposal;
      ob.picks = { spaces: proposal.spaces.map(() => true), favorites: proposal.favorites.map(() => true), arc: !!ob.arc && useArc, logins: ob.arcLogins, agents: false };
      await new Promise((r) => setTimeout(r, 1100));
      if (ob.el && ob.steps[ob.step] === 'tailor') showObStep(ob.step + 1, 1);
    },
  },

  // ------------------------------------------------------------ the proposal, as a live preview
  preview: {
    html: () => {
      const p = ob.proposal || { title: 'Your Meridian', spaces: [{ name: 'Personal', icon: '🏠', color: space().color }], favorites: [], mode: 'everyday', color: space().color, source: 'rules' };
      ob.proposal = p;
      ob.picks ||= { spaces: p.spaces.map(() => true), favorites: p.favorites.map(() => true), arc: !!ob.arc, logins: ob.arcLogins, agents: false };
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
              <div class="ob-pv-spaces ${k.arc ? 'dim' : ''}">${p.spaces.map((s, i) => `<button class="ob-pv-space ${k.spaces[i] ? '' : 'off'}" data-space="${i}" style="--c:${esc(s.color)}"><em>${esc(s.icon)}</em>${esc(s.name)}</button>`).join('')}</div>
              <div class="ob-pv-rows"><i></i><i></i><i class="s"></i></div>
            </div>
            <div class="ob-pv-page"><div class="ob-pv-chip">${icon(p.mode === 'developer' ? 'code' : p.mode === 'creative' ? 'sparkles' : 'globe', 14)} ${esc(modeLabel)}</div><i class="w60"></i><i></i><i class="w80"></i></div>
          </div>
          <div class="ob-pv-opts">
            ${ob.arc ? `<button class="ob-opt ${k.arc ? 'on' : ''}" data-opt="arc"><span class="ob-opt-ic">${icon('download', 16)}</span><span><b>Bring my Arc</b><em>${ob.arc.spaces} spaces${ob.arcLogins ? ', and logins' : ''}</em></span><span class="ob-tick">${icon('check', 13)}</span></button>` : ''}
            ${p.mode === 'developer' ? `<button class="ob-opt ${k.agents ? 'on' : ''}" data-opt="agents"><span class="ob-opt-ic">${icon('terminal', 16)}</span><span><b>Let coding agents use the browser</b><em>They ask before every action</em></span><span class="ob-tick">${icon('check', 13)}</span></button>` : ''}
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
        if (o) { k[o.dataset.opt] = !k[o.dataset.opt]; o.classList.toggle('on', k[o.dataset.opt]); if (o.dataset.opt === 'arc') $('.ob-pv-spaces', page).classList.toggle('dim', k.arc); }
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

  // ------------------------------------------------------------ done
  done: {
    html: async () => {
      const isDefault = await api.isDefaultBrowser().catch(() => false);
      return `
        <div class="ob-hero">
          <div class="ob-mark done">${icon('check', 54)}</div>
          <h1>You’re all set</h1>
          <p class="ob-whisper">Press <kbd>⌘</kbd><kbd>T</kbd> to open anything — or just ask it a question.</p>
          ${isDefault ? '' : `<button class="ob-btn soft ob-default-btn" id="ob-default">${icon('globe', 15)} Make Meridian my default browser</button>`}
        </div>`;
    },
    cta: () => 'Start browsing',
    bind(page) {
      $('#ob-default', page)?.addEventListener('click', async (e) => { e.currentTarget.disabled = true; await setDefaultBrowser(); e.currentTarget.innerHTML = `${icon('check', 15)} Asked macOS`; });
      $('.ob-mark', page).animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)' }], { duration: 700, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    },
  },
};

// Make the picks real: mode, AI, spaces (or Arc), favorites, colour.
async function applyProposal() {
  const p = ob.proposal, k = ob.picks;
  if (!p) return;
  const patch = { mode: p.mode };
  if (ob.provider && !state.settings.aiProvider) patch.aiProvider = ob.provider;
  if (k.agents) patch.agentAccess = 'ask';
  applySettingsPatch(patch);
  if (k.arc && ob.arc) {
    const r = await importArc({ quiet: true });
    if (r && k.logins && ob.arcLogins) {
      const l = await api.importArcLogins().catch(() => null);
      if (l?.ok && l.total) toast(`Brought over ${l.total.toLocaleString()} logins from Arc`, { timeout: 5000 });
    }
  } else {
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
