/* Meridian Workbench — what each agent session in this Workbench is doing, from verified signals only.
 *
 * The states come from Claude Code's own hooks, as Mission Control (C++) reads them; this page gets
 * them with its 'mission' host message ({ sessions: { <terminal id>: { chat, text, tool, ask } } }),
 * sent only while the page has said it lists sessions (SessionStatus.report):
 *   'needs'   — it (or a subagent) waits for you: a permission prompt or a question
 *               (PermissionRequest, Notification permission_prompt / elicitation_dialog);
 *   'working' — a turn runs (UserPromptSubmit, PreToolUse… until Stop);
 *   'done'    — a turn ended (Stop) while that session wasn't the one on screen; cleared once shown;
 *   'idle'    — nothing of the above;
 *   ''        — no hooks to go by (Codex and the other agents, a plain shell): show no status.
 * Never guessed from terminal text.
 *
 * API (a global, like the other Workbench scripts):
 *   SessionStatus.get(termId)      -> { state, text, tool, ask, since } (state '' when unknown)
 *   SessionStatus.words(termId)    -> the state in words: 'Needs permission: Bash(dotnet test)', 'PR #12 ready for review' …
 *   SessionStatus.mark(state)      -> a <span class="ss-mark"> (orange dot, spinner, blue dot), or null
 *   SessionStatus.onChange(fn)     -> unsubscribe; fn() after any state changes
 *   SessionStatus.report(view)     -> tells Meridian what this page lists:
 *                                     { on: bool, onScreen: termId|'' , order: [termId…] }
 *                                     (sent only when it changes; { on: false } stops the states)
 *   SessionStatus.lastAnswer(id)   -> the first line of a done session's last answer ('' until read)
 *
 * What a session wants, as a kind (beta3; the same verified signals, plus its last answer read
 * from its transcript):
 *   'permission' — a permission prompt (PermissionRequest / Notification permission_prompt);
 *   'question'   — it asks you something (AskUserQuestion, an elicitation / question notification);
 *   'error'      — its turn failed (StopFailure) or the turn's last tool call failed;
 *   'pr'         — the turn ended and its last answer links a pull / merge request;
 *   'result'     — the turn ended having written files, or its answer links a page;
 *   'done'       — the turn ended, nothing of the above (not seen yet);
 *   'working'    — a turn runs; ''  — idle, seen, or nothing known.
 * Priority when several apply: permission / question > error > pr > result > done.
 *   SessionStatus.kind(termId)     -> one of the kinds above
 *   SessionStatus.info(termId)     -> { kind, words, link } (link: { type: 'pr'|'url'|'file', href|path, label } or null)
 *   SessionStatus.icon(kind, size) -> a <span class="ss-kind <kind>" title> with the kind's icon, or null
 *   SessionStatus.open(termId)     -> opens the session's link (PR / page in a tab, a file in the editor); true if it did
 *   SessionStatus.rank(kind)       -> 5 permission/question, 4 error, 3 pr, 2 result, 1 done, 0 working, -1 none
 *   SessionStatus.top(termIds)     -> { kind, count } of the highest-ranking kind among them (count: that rank)
 *   SessionStatus.classify(s, a)   -> the kind of a state `s` (as get() returns) given its answer text `a` (pure)
 * report() also sends that top kind for the sidebar's mark (badge: { kind, count }).
 */
const SessionStatus = (() => {
  const states = new Map(); // termId -> { state, text, tool, ask, turn, since }
  const answers = new Map(); // termId -> { line, text } of the last answer
  const listeners = new Set();
  let lastReport = '';
  let view = null; // what the page lists (report())
  let on = false;

  const clean = (s, n = 140) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

  function fire() { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } sendReport(); }

  function onMission(msg) {
    if (!on || !msg || msg.type !== 'mission') return;
    const sessions = msg.sessions && typeof msg.sessions === 'object' ? msg.sessions : {};
    let changed = false;
    const seen = new Set();
    for (const [id, s] of Object.entries(sessions)) {
      if (!s || typeof s !== 'object') continue;
      seen.add(id);
      const state = ['needs', 'working', 'done', 'idle'].includes(s.chat) ? s.chat : '';
      const tool = s.tool && typeof s.tool === 'object' ? { name: clean(s.tool.name, 60), summary: clean(s.tool.summary) } : null;
      const ask = s.ask && typeof s.ask === 'object' ? { tool: clean(s.ask.tool, 60), summary: clean(s.ask.summary) } : null;
      const t = s.turn && typeof s.turn === 'object' ? s.turn : {};
      const turn = { files: (Array.isArray(t.files) ? t.files : []).map((f) => clean(f, 200)).filter(Boolean).slice(0, 5), failed: t.failed === true, error: t.error === true };
      const text = clean(s.text);
      const prev = states.get(id);
      const next = { state, text, tool, ask, turn, since: prev && prev.state === state ? prev.since : Date.now() };
      if (!prev || JSON.stringify({ ...prev, since: 0 }) !== JSON.stringify({ ...next, since: 0 })) {
        states.set(id, next);
        changed = true;
        if (state === 'done' && prev?.state !== 'done') readAnswer(id);
      }
    }
    for (const id of [...states.keys()]) if (!seen.has(id)) { states.delete(id); changed = true; }
    if (changed) fire();
  }

  async function readAnswer(id) {
    if (typeof wb?.termLastAnswer !== 'function') return;
    let text = '';
    try { text = await wb.termLastAnswer(id); } catch { return; }
    text = String(text || '').slice(0, 20000);
    const line = clean(text.split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').trim()).find(Boolean) || '', 120);
    const prev = answers.get(id);
    if (prev && prev.text === text) return;
    answers.set(id, { line, text });
    fire();
  }

  const EMPTY = { state: '', text: '', tool: null, ask: null, turn: { files: [], failed: false, error: false }, since: 0 };
  function get(id) { return states.get(String(id)) || EMPTY; }

  // A tool call the way Claude Code writes it: Bash(npm test), Read(src/app.js).
  function call(name, summary) {
    if (!name) return '';
    const arg = (summary || '').replace(/^\$ /, '');
    return arg ? `${name}(${arg})` : name;
  }

  // ------------------------------------------------------------ kinds

  const PR_RE = [
    { re: /https:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\b/g, label: (n) => `PR #${n}` },
    { re: /https:\/\/[\w.-]*gitlab[\w.-]*\/[\w./-]+?\/-\/merge_requests\/(\d+)\b/g, label: (n) => `MR !${n}` },
    { re: /https:\/\/(?:www\.)?bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/(\d+)\b/g, label: (n) => `PR #${n}` },
  ];
  const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+[^\s<>()\[\]"'`.,;:!?]/g;

  // The last pull / merge request the answer links.
  function prLink(answer) {
    let best = null;
    for (const { re, label } of PR_RE) {
      for (const m of String(answer || '').matchAll(re)) {
        if (!best || m.index >= best.at) best = { at: m.index, link: { type: 'pr', href: m[0], label: label(m[1]) } };
      }
    }
    return best ? best.link : null;
  }

  function urlLink(answer) {
    const all = [...String(answer || '').matchAll(URL_RE)].map((m) => m[0]);
    const href = all[all.length - 1];
    if (!href) return null;
    let label = href;
    try { const u = new URL(href); label = (u.host + (u.pathname === '/' ? '' : u.pathname)).slice(0, 60); } catch { return null; }
    return { type: 'url', href, label };
  }

  const isQuestion = (s) => s.ask?.tool === 'AskUserQuestion' || s.tool?.name === 'AskUserQuestion';

  // The kind of a state, given its last answer: pure, for the views and the tests.
  function classify(s, answer = '') {
    if (!s || !s.state) return '';
    if (s.state === 'needs') {
      if (isQuestion(s)) return 'question';
      if (s.ask || /permission|^Needs permission/i.test(s.text || '')) return 'permission';
      // A notification that waits for you without a permission prompt: an elicitation / a question.
      return s.text ? 'question' : 'permission';
    }
    if (s.state === 'working') return isQuestion(s) ? 'question' : 'working';
    if (s.state === 'done') {
      if (s.turn?.error || s.turn?.failed) return 'error';
      if (prLink(answer)) return 'pr';
      if (s.turn?.files?.length || urlLink(answer)) return 'result';
      return 'done';
    }
    return '';
  }

  function rank(kind) {
    return { permission: 5, question: 5, error: 4, pr: 3, result: 2, done: 1, working: 0 }[kind] ?? -1;
  }

  const answerOf = (id) => answers.get(String(id))?.text || '';
  function kind(id) { return classify(get(id), answerOf(id)); }

  function linkOf(id) {
    const s = get(id);
    const k = kind(id);
    if (k === 'pr') return prLink(answerOf(id));
    if (k === 'result') return s.turn.files.length ? { type: 'file', path: s.turn.files[0], label: s.turn.files[0] } : urlLink(answerOf(id));
    return null;
  }

  function top(ids) {
    let best = '', count = 0;
    for (const id of ids || []) {
      const k = kind(id);
      if (rank(k) < 0) continue;
      if (rank(k) > rank(best)) { best = k; count = 1; } else if (rank(k) === rank(best)) count++;
    }
    return { kind: best, count: best ? count : 0 };
  }

  function words(id) {
    const s = get(id);
    const k = kind(id);
    switch (k) {
      case 'permission': {
        const what = s.ask?.tool ? call(s.ask.tool, s.ask.summary) : s.tool?.name ? call(s.tool.name, s.tool.summary) : '';
        return what ? `Needs permission: ${what}` : s.text && !/^Needs permission/.test(s.text) ? `Needs permission · ${s.text}` : 'Needs permission';
      }
      case 'question': {
        const what = s.ask?.tool === 'AskUserQuestion' ? s.ask.summary : s.tool?.name === 'AskUserQuestion' ? s.tool.summary : s.text;
        return what ? `Asks: ${what}` : 'Asks you something';
      }
      case 'error': return s.turn.error ? 'Error: the turn failed' : 'Error: its last step failed';
      case 'pr': return `${linkOf(id).label} ready for review`;
      case 'result': {
        const l = linkOf(id);
        const more = l.type === 'file' && s.turn.files.length > 1 ? ` +${s.turn.files.length - 1} file${s.turn.files.length > 2 ? 's' : ''}` : '';
        return `Result: ${l.label}${more}`;
      }
      case 'working': {
        const what = s.tool?.name ? call(s.tool.name, s.tool.summary) : '';
        return `Working${what ? ' · ' + what : ''}`;
      }
      case 'done': {
        const a = answers.get(String(id))?.line;
        return `Done${a ? ' · ' + a : ''}`;
      }
      default: return s.state === 'idle' ? 'Idle' : '';
    }
  }

  function info(id) { return { kind: kind(id), words: words(id), link: linkOf(id) }; }

  // Opens what the session points at: a PR or a page in a tab, a written file in the editor.
  function open(id) {
    const l = linkOf(id);
    if (!l) return false;
    if (l.type === 'file') {
      if (typeof openFile !== 'function') return false;
      openFile(l.path, { focus: true });
      return true;
    }
    wb.toHost({ type: 'link', url: l.href });
    return true;
  }

  // The kinds' icons: Meridian's icon style (24-unit grid, 2px round strokes), in currentColor.
  const PATHS = {
    permission: '<path d="M12 3.2l7 2.9v5.1c0 4.4-2.9 8.1-7 9.6-4.1-1.5-7-5.2-7-9.6V6.1z"/><circle cx="12" cy="10.6" r="1.7"/><path d="M12 12.3v3.4"/>',
    question: '<path d="M20.2 11.6a8.2 8.2 0 0 1-11.9 7.3L3.8 20l1.2-4.2a8.2 8.2 0 1 1 15.2-4.2z"/><path d="M9.9 9.4a2.2 2.2 0 0 1 4.3.6c0 1.5-2.2 1.9-2.2 3.3"/><path d="M12 16.1v.1"/>',
    error: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5.3"/><path d="M12 16.3v.1"/>',
    pr: '<circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="18" r="2.2"/><path d="M6.5 8.2v7.6"/><path d="M17.5 15.8V9.5a3 3 0 0 0-3-3H11"/><path d="M13.2 4.2L10.9 6.5l2.3 2.3"/>',
    result: '<path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8-4.8-1.7 4.8-1.7z"/><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    done: '<path d="M5.5 12.6l4.2 4.2 8.8-9.3"/>',
  };
  const TITLES = { permission: 'Needs permission', question: 'Asks you something', error: 'Error', pr: 'Pull request to review', result: 'Result ready', done: 'Done — not seen yet', working: 'Working' };

  function icon(k, size = 12) {
    if (!TITLES[k]) return null;
    const el = document.createElement('span');
    el.className = `ss-kind ${k}`;
    el.dataset.kind = k;
    el.title = TITLES[k];
    if (PATHS[k]) el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[k]}</svg>`;
    return el;
  }

  function mark(state) {
    if (!['needs', 'working', 'done'].includes(state)) return null;
    const m = document.createElement('span');
    m.className = `ss-mark ${state}`;
    m.dataset.state = state;
    m.title = state === 'needs' ? 'Needs you' : state === 'working' ? 'Working' : 'Done — not seen yet';
    return m;
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function sendReport() {
    const next = view && view.on
      ? { type: 'chats', on: true, onScreen: String(view.onScreen || ''), order: (view.order || []).map(String).slice(0, 200) }
      : { type: 'chats', on: false };
    if (next.on) next.badge = top(next.order);
    const key = JSON.stringify(next);
    if (key === lastReport) return;
    lastReport = key;
    const was = on;
    on = !!next.on;
    if (was && !on) { states.clear(); answers.clear(); for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } }
    wb.toHost(next);
  }

  function report(v) { view = v && v.on ? { on: true, onScreen: v.onScreen, order: v.order } : null; sendReport(); }

  if (typeof wb !== 'undefined' && typeof wb.onHostCommand === 'function') wb.onHostCommand(onMission);
  return Object.freeze({
    get, words, mark, onChange, report, lastAnswer: (id) => answers.get(String(id))?.line || '',
    kind, info, icon, open, rank, top, classify,
  });
})();
