/* Meridian — welcome tour (full window, Arc-style).
 *
 * Welcome → How you'll use it (mode) → Make it yours (colour, live) → Import from Arc (only when Arc
 * data exists) → Default browser → The basics (try the shortcuts) → Connect your AI (Claude Code, Codex,
 * Gemini… on the user's own subscription) → [Developer mode: agent access + MCP] → Done.
 * Re-runnable from Help → Welcome Tour and Settings → General. Completion is saved as state.onboarded.
 * Loaded after app.js / panels.js and shares their globals.
 */

const ob = { el: null, step: 0, steps: [], tried: new Set(), arc: null, clis: null, imported: null, poll: null };

const TOUR = [
  { cmd: 'command-bar', keys: '⌘T', title: 'Open anything', desc: 'The command bar searches your tabs, history and the web, and runs commands.' },
  { cmd: 'toggle-sidebar', keys: '⌘S', title: 'Hide the sidebar', desc: 'Full-width pages. Hover the window edge to bring it back.' },
  { cmd: 'space-step', keys: '⌘⌥→', title: 'Switch spaces', desc: 'Or swipe sideways with two fingers on the sidebar.', swipe: true },
  { cmd: 'split', keys: '^⇧=', title: 'Split view', desc: 'Two pages side by side. Drag the divider to resize.' },
  { cmd: 'peek', keys: '', title: 'Peek', desc: 'Links from pinned tabs to other sites open in a preview you can expand.', manual: true },
];

async function startOnboarding() {
  if (EPHEMERAL || ob.el) return;
  closePanels?.();
  ob.step = 0; ob.tried = new Set(); ob.imported = null;
  ob.arc = await api.arcPreview().catch(() => null);
  ob.steps = obSteps();
  const el = document.createElement('div');
  el.id = 'onboarding';
  el.innerHTML = `
    <div class="ob-bg"><i class="b1"></i><i class="b2"></i><i class="b3"></i></div>
    <div class="ob-top"><div class="grow"></div><button class="ob-skip" data-ob="skip">Skip tour</button></div>
    <div class="ob-stage"></div>
    <div class="ob-foot">
      <button class="ob-btn ghost" data-ob="back">${icon('arrowLeft', 16)} Back</button>
      <div class="ob-dots"></div>
      <button class="ob-btn primary" data-ob="next">Continue ${icon('arrowRight', 16)}</button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('onboarding');
  ob.el = el;
  el.addEventListener('click', onObClick);
  el.addEventListener('wheel', (e) => {
    if (ob.steps[ob.step] === 'basics' && Math.abs(e.deltaX) > 30 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) markTried('space-step');
  }, { passive: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('input, button')) { e.preventDefault(); obNext(); }
  });
  showObStep(0);
}

// Developer mode adds the agent-access / MCP step; the others don't need it.
function obSteps() {
  return ['welcome', 'mode', 'theme', ...(ob.arc && !ob.arc.error && ob.arc.spaces ? ['arc'] : []), 'default', 'basics', 'ai',
    ...(uiMode() === 'developer' && state.settings.mode ? ['devtools'] : []), 'done'];
}

function finishOnboarding() {
  state.onboarded = true; save();
  const el = ob.el;
  ob.el = null;
  clearInterval(ob.poll);
  if (!state.settings.mode) state.settings.mode = 'everyday';
  document.body.classList.remove('onboarding');
  render();
  if (!el) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 380);
}

// While the tour is open its shortcuts become "try it" checkmarks instead of acting.
function onboardingIntercept(name) {
  if (!ob.el) return false;
  const t = TOUR.find((x) => x.cmd === name);
  if (!t) return false;
  if (ob.steps[ob.step] === 'basics') markTried(name);
  return true;
}

function markTried(cmd) {
  if (ob.tried.has(cmd)) return;
  ob.tried.add(cmd);
  const card = ob.el?.querySelector(`.ob-key[data-cmd="${cmd}"]`);
  if (card) { card.classList.add('done'); card.animate([{ transform: 'scale(0.97)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' }); }
  const left = TOUR.length - ob.tried.size;
  const p = ob.el?.querySelector('.ob-progress');
  if (p) p.textContent = left ? `${ob.tried.size} of ${TOUR.length} tried` : 'All done — you’re a natural.';
}

function onObClick(e) {
  const a = e.target.closest('[data-ob]')?.dataset.ob;
  if (!a) return;
  if (a === 'skip') return finishOnboarding();
  if (a === 'back') return showObStep(Math.max(0, ob.step - 1), -1);
  if (a === 'next') return obNext();
  if (a.startsWith('goto:')) return showObStep(Number(a.slice(5)));
}

function obNext() {
  if (ob.step >= ob.steps.length - 1) return finishOnboarding();
  showObStep(ob.step + 1, 1);
}

async function showObStep(i, dir = 1) {
  ob.step = i;
  const name = ob.steps[i];
  const stage = $('.ob-stage', ob.el);
  const page = document.createElement('div');
  page.className = `ob-page ob-step-${name}`;
  page.innerHTML = await OB_STEPS[name].html();
  const old = stage.firstElementChild;
  if (old) {
    old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 40}px)` }], { duration: 200, easing: 'ease-in', fill: 'forwards' }).onfinish = () => old.remove();
  }
  stage.appendChild(page);
  page.animate([{ opacity: 0, transform: `translateX(${dir * 50}px)` }, { opacity: 1, transform: 'none' }], { duration: 420, delay: old ? 120 : 0, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' });
  OB_STEPS[name].bind?.(page);
  $('.ob-dots', ob.el).innerHTML = ob.steps.map((s, j) => `<button class="ob-dot ${j === i ? 'on' : ''} ${j < i ? 'past' : ''}" data-ob="goto:${j}" title="${esc(s)}"></button>`).join('');
  $('[data-ob="back"]', ob.el).style.visibility = i === 0 || name === 'done' ? 'hidden' : 'visible';
  const next = $('[data-ob="next"]', ob.el);
  next.innerHTML = name === 'welcome' ? `Get Started ${icon('arrowRight', 16)}` : name === 'done' ? `Start Browsing ${icon('arrowRight', 16)}` : `Continue ${icon('arrowRight', 16)}`;
  $('.ob-skip', ob.el).style.visibility = name === 'done' ? 'hidden' : 'visible';
  localizeKeys(ob.el);
  setTimeout(() => next.focus(), 50);
}

const LOGO_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 7 64 64" class="ob-logo"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="50" r="4.5" fill="currentColor"/></svg>`;

const OB_STEPS = {
  welcome: {
    html: () => `
      <div class="ob-hero">
        <div class="ob-mark">${LOGO_SVG(86)}</div>
        <h1>Welcome to Meridian</h1>
        <p class="ob-lead">A calmer way to browse. Spaces, pinned tabs, a Today list that tidies itself, split view and Peek — open source, and built for AI agents.</p>
      </div>`,
  },

  theme: {
    html: () => {
      const sp = space();
      return `
        <h2>Make it yours</h2>
        <p class="ob-lead">Pick a colour for your first space. Every space can have its own.</p>
        <div class="ob-theme">
          <div class="ob-mini" style="--a:${esc(sp.color)};--b:${esc(sp.color2 || sp.color)}">
            <div class="m-side"><div class="m-url"></div><div class="m-fav"><i></i><i></i><i></i></div><div class="m-row on"></div><div class="m-row"></div><div class="m-row"></div><div class="m-row s"></div></div>
            <div class="m-page"><div class="m-line w60"></div><div class="m-line"></div><div class="m-line w80"></div><div class="m-block"></div></div>
          </div>
          <div class="ob-swatches">${THEME_PRESETS.map((p, i) => `<button class="ob-sw" data-i="${i}" style="--a:${p[0]};--b:${p[1] || p[0]}"></button>`).join('')}</div>
          <div class="ob-appear">${[['system', 'Auto', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([v, l, ic]) => `<button class="ob-chip ${((state.settings.appearance || 'system') === v) ? 'on' : ''}" data-ap="${v}">${icon(ic, 15)} ${l}</button>`).join('')}</div>
        </div>`;
    },
    bind(page) {
      const sp = space();
      const sync = () => {
        $('.ob-mini', page).style.setProperty('--a', sp.color);
        $('.ob-mini', page).style.setProperty('--b', sp.color2 || sp.color);
        $$('.ob-sw', page).forEach((b) => { const p = THEME_PRESETS[b.dataset.i]; b.classList.toggle('on', p[0] === sp.color && (p[1] || null) === (sp.color2 || null)); });
      };
      $('.ob-swatches', page).onclick = (e) => {
        const b = e.target.closest('.ob-sw'); if (!b) return;
        const p = THEME_PRESETS[b.dataset.i];
        sp.color = p[0]; if (p[1]) sp.color2 = p[1]; else delete sp.color2;
        sync(); render(); save();
      };
      $('.ob-appear', page).onclick = (e) => {
        const b = e.target.closest('[data-ap]'); if (!b) return;
        $$('[data-ap]', page).forEach((x) => x.classList.toggle('on', x === b));
        applySettingsPatch({ appearance: b.dataset.ap });
      };
      sync();
    },
  },

  arc: {
    html: () => {
      const a = ob.arc;
      const stat = (n, l) => `<div class="ob-stat"><b>${n}</b><span>${l}</span></div>`;
      return `
        <h2>Bring your Arc with you</h2>
        <p class="ob-lead">We found Arc on this computer. Import your sidebar in one go — nothing is changed in Arc.</p>
        <div class="ob-arc">
          <div class="ob-stats">${stat(a.spaces, a.spaces === 1 ? 'space' : 'spaces')}${stat(a.pinned, 'pinned tabs')}${stat(a.favorites, 'favorites')}${stat(a.today, 'open tabs')}</div>
          <div class="ob-spaces">${a.names.map((s) => `<span class="ob-space" style="--c:${esc(s.color)}">${s.icon ? `<em>${esc(s.icon)}</em>` : '<i></i>'}${esc(s.name)}</span>`).join('')}${a.spaces > a.names.length ? `<span class="ob-space more">+${a.spaces - a.names.length} more</span>` : ''}</div>
          <div class="ob-arc-act">${ob.imported ? `<span class="ob-ok">${icon('check', 18)} Imported</span>` : `<button class="ob-btn primary big" id="ob-import">${icon('download', 16)} Import from Arc</button>`}</div>
          <p class="ob-fine">Logins don’t transfer (Arc encrypts them with its own key). You’ll sign in once per profile.</p>
        </div>`;
    },
    bind(page) {
      $('#ob-import', page)?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Importing…';
        ob.imported = await importArc();
        showObStep(ob.step, 0);
      });
    },
  },

  default: {
    html: async () => {
      const isDefault = await api.isDefaultBrowser().catch(() => false);
      return `
        <h2>Make Meridian your browser</h2>
        <p class="ob-lead">Links from Mail, Slack, Notion and everything else open here. Air Traffic Control sends them to the right space, or to a Little window for a quick look.</p>
        <div class="ob-default">
          <div class="ob-routes">
            <div class="ob-route"><span class="ob-app">${icon('link', 18)}</span>${icon('arrowRight', 16)}<span class="ob-dest">${icon('littleWindow', 18)} Little window</span></div>
            <div class="ob-route"><span class="ob-app">github.com</span>${icon('arrowRight', 16)}<span class="ob-dest"><i style="background:var(--space)"></i> ${esc(space().name)}</span></div>
          </div>
          ${isDefault ? `<span class="ob-ok">${icon('check', 18)} Meridian is your default browser</span>` : `<button class="ob-btn primary big" id="ob-default">${icon('globe', 16)} Set as Default Browser</button>`}
          <p class="ob-fine">You can set up routing rules any time in Settings → Links.</p>
        </div>`;
    },
    bind(page) {
      $('#ob-default', page)?.addEventListener('click', async () => { await setDefaultBrowser(); setTimeout(() => showObStep(ob.step, 0), 1200); });
    },
  },

  basics: {
    html: () => `
      <h2>The basics</h2>
      <p class="ob-lead">Try each one now — press the keys.</p>
      <div class="ob-keys">${TOUR.map((t) => `
        <div class="ob-key ${ob.tried.has(t.cmd) ? 'done' : ''}" data-cmd="${t.cmd}">
          <div class="ob-key-caps">${t.keys ? [...t.keys.matchAll(/\^|[⌘⌥⇧]|[^⌘⌥⇧^]+/g)].map((m) => `<kbd>${esc(m[0])}</kbd>`).join('') : `<span class="ob-peek-demo"><i></i></span>`}</div>
          <div class="ob-key-text"><b>${esc(t.title)}</b><span>${esc(t.desc)}</span></div>
          ${t.manual ? '<button class="ob-chip small" data-try="peek">Show me</button>' : ''}
          <span class="ob-check">${icon('check', 14)}</span>
        </div>`).join('')}</div>
      <div class="ob-progress">${ob.tried.size ? `${ob.tried.size} of ${TOUR.length} tried` : 'Press any of the shortcuts above'}</div>`,
    bind(page) {
      page.addEventListener('click', (e) => {
        if (!e.target.closest('[data-try="peek"]')) return;
        const card = e.target.closest('.ob-key');
        card.classList.add('peeking');
        setTimeout(() => card.classList.remove('peeking'), 1600);
        markTried('peek');
      });
    },
  },

  mode: {
    html: () => {
      const cur = state.settings.mode || '';
      const card = (v, ic, title, desc) => `<button class="ob-mode ${cur === v ? 'on' : ''}" data-mode="${v}"><span class="ob-mode-ic">${icon(ic, 22)}</span><b>${title}</b><span>${desc}</span></button>`;
      return `
        <h2>How will you use Meridian?</h2>
        <p class="ob-lead">We’ll keep things simple and show what you need. You can switch any time in Settings.</p>
        <div class="ob-modes">
          ${card('everyday', 'globe', 'Everyday browsing', 'The calm Arc way to browse. Ask any question right in the command bar.')}
          ${card('creative', 'sparkles', 'AI for work', 'For designers, managers and writers: chat with your AI next to your tabs, like the Claude or ChatGPT app.')}
          ${card('developer', 'code', 'Developer', 'Everything above, plus a mini IDE with Claude Code and Codex, Mission Control and an MCP server.')}
        </div>`;
    },
    bind(page) {
      $('.ob-modes', page).onclick = (e) => {
        const b = e.target.closest('[data-mode]'); if (!b) return;
        $$('[data-mode]', page).forEach((x) => x.classList.toggle('on', x === b));
        applySettingsPatch({ mode: b.dataset.mode });
        ob.steps = obSteps();
        $('.ob-dots', ob.el).innerHTML = ob.steps.map((st, j) => `<button class="ob-dot ${j === ob.step ? 'on' : ''} ${j < ob.step ? 'past' : ''}" data-ob="goto:${j}" title="${esc(st)}"></button>`).join('');
        setTimeout(obNext, 260);
      };
    },
  },

  ai: {
    html: async () => {
      const agents = await api.agentsList(true).catch(() => []);
      const hasKey = await api.aiHasKey().catch(() => false);
      const chosen = state.settings.aiProvider || '';
      const ready = (a) => a.installed && a.loggedIn !== false;
      const auto = !chosen && agents.find(ready);
      const btn = (a) => !a.installed
        ? (a.install?.cmd ? `<button class="ob-btn small" data-setup="install" data-id="${a.id}">Install</button>` : `<span class="ob-tag">needs ${esc(a.install?.missing || 'setup')}</span>`)
        : a.loggedIn === false ? `<button class="ob-btn small primary" data-setup="login" data-id="${a.id}">Sign in</button>`
        : `<span class="ob-ok small">${icon('check', 15)} Ready</span>`;
      const on = (a) => chosen === a.id || (auto && auto.id === a.id);
      return `
        <h2>Connect your AI</h2>
        <p class="ob-lead">For the full experience, connect the AI you already pay for. Meridian uses it to answer questions in the command bar${uiMode() !== 'everyday' ? ', in chat' : ''} and about any page. No extra subscription, no API key.</p>
        <div class="ob-agents">${agents.map((a) => `
          <div class="ob-agent ${on(a) ? 'on' : ''} ${ready(a) ? 'ready' : ''}" data-pick="${a.id}">
            <span class="ob-agent-mark" style="--c:${({ claude: '#d97757', codex: '#10a37f', gemini: '#4285f4', copilot: '#8957e5' })[a.id] || '#777'}">${esc(a.label[0])}</span>
            <div class="ob-agent-text"><b>${esc(a.label)}</b><span>${esc(a.vendor)} · ${esc(a.plan)}</span></div>
            ${btn(a)}
          </div>`).join('')}
        </div>
        <p class="ob-fine">${hasKey ? 'Your Claude API key works too. ' : 'Prefer an API key? Add it in Settings → AI. '}Agents answer as text here — they can’t run commands or change files.</p>`;
    },
    bind(page) {
      page.addEventListener('click', async (e) => {
        const setup = e.target.closest('[data-setup]');
        if (setup) {
          e.stopPropagation();
          const r = await api.agentsSetup(setup.dataset.id, setup.dataset.setup).catch((err) => ({ ok: false, error: err.message }));
          if (r.cancelled) return;
          if (!r.ok) return toast(r.error || 'Couldn’t start setup', { timeout: 6000 });
          setup.disabled = true; setup.textContent = setup.dataset.setup === 'install' ? 'Installing…' : 'Signing in…';
          // Re-check every few seconds; redraw this step when something changes.
          clearInterval(ob.poll);
          const start = Date.now(), before = JSON.stringify(await api.agentsList().catch(() => []));
          ob.poll = setInterval(async () => {
            if (!ob.el || ob.steps[ob.step] !== 'ai' || Date.now() - start > 5 * 60_000) return clearInterval(ob.poll);
            const now = JSON.stringify(await api.agentsList(true).catch(() => []));
            if (now !== before) { clearInterval(ob.poll); aiAgents.at = 0; showObStep(ob.step, 0); }
          }, 3000);
          return;
        }
        const pick = e.target.closest('[data-pick].ready');
        if (pick) {
          $$('[data-pick]', page).forEach((x) => x.classList.toggle('on', x === pick));
          applySettingsPatch({ aiProvider: pick.dataset.pick });
        }
      });
    },
  },

  devtools: {
    html: async () => {
      ob.clis ||= await api.mcpDetect().catch(() => ({}));
      const access = state.settings.agentAccess || 'off';
      const cli = (id) => {
        const c = ob.clis[id];
        if (!c || (!c.path && id === 'codex')) return '';
        return `<div class="ob-cli">
          <div class="ob-cli-head">${icon('terminal', 16)}<b>${esc(c.name)}</b>${c.path ? '' : '<span class="ob-tag">not found on PATH</span>'}<div class="grow"></div>${c.path ? `<button class="ob-btn small primary" data-connect="${id}">Connect</button>` : ''}</div>
          <code>${esc(c.command)}</code>
        </div>`;
      };
      return `
        <h2>Let agents use the browser</h2>
        <p class="ob-lead">Coding agents like Claude Code can read and drive Meridian through its MCP server — only as much as you allow.</p>
        <div class="ob-ai">
          <div class="ob-access">${AGENT_ACCESS.map(([v, l, d]) => `<button class="ob-acc ${access === v ? 'on' : ''}" data-acc="${v}"><b>${esc(l)}</b><span>${esc(d)}</span></button>`).join('')}</div>
          ${cli('claude')}${cli('codex')}
          <p class="ob-fine">Connect runs the command shown, after you confirm. Change all of this later in Settings → AI.</p>
        </div>`;
    },
    bind(page) {
      $('.ob-access', page).onclick = async (e) => {
        const b = e.target.closest('[data-acc]'); if (!b) return;
        if (b.dataset.acc === 'full' && !(await confirmBox('Let AI agents click, type and navigate in your logged-in browser without asking?', 'Allow full control'))) return;
        $$('[data-acc]', page).forEach((x) => x.classList.toggle('on', x === b));
        applySettingsPatch({ agentAccess: b.dataset.acc });
      };
      page.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-connect]'); if (!b) return;
        b.disabled = true; b.textContent = 'Waiting…';
        const r = await api.mcpConnect(b.dataset.connect).catch((err) => ({ ok: false, error: err.message }));
        b.disabled = false;
        if (r.ok) { b.outerHTML = `<span class="ob-ok small">${icon('check', 15)} ${r.already ? 'Already connected' : 'Connected'}</span>`; if ((state.settings.agentAccess || 'off') === 'off') toast('Pick an access level above so the agent can do something'); }
        else { b.textContent = 'Connect'; if (!r.cancelled) toast(`Couldn’t connect: ${r.error}`, { timeout: 6000 }); }
      });
    },
  },

  done: {
    html: () => `
      <div class="ob-hero">
        <div class="ob-mark done">${icon('check', 54)}</div>
        <h1>You’re all set</h1>
        <p class="ob-lead">Press <kbd>⌘</kbd><kbd>T</kbd> to open your first tab. Settings live under <kbd>⌘</kbd><kbd>,</kbd> — and this tour is in the Help menu if you want it again.</p>
      </div>`,
  },
};
