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
 *   SessionStatus.words(termId)    -> the state in words: 'Needs you · Allow Bash(dotnet test)?' …
 *   SessionStatus.mark(state)      -> a <span class="ss-mark"> (orange dot, spinner, blue dot), or null
 *   SessionStatus.onChange(fn)     -> unsubscribe; fn() after any state changes
 *   SessionStatus.report(view)     -> tells Meridian what this page lists:
 *                                     { on: bool, onScreen: termId|'' , order: [termId…] }
 *                                     (sent only when it changes; { on: false } stops the states)
 *   SessionStatus.lastAnswer(id)   -> the first line of a done session's last answer ('' until read)
 */
const SessionStatus = (() => {
  const states = new Map(); // termId -> { state, text, tool, ask, since }
  const answers = new Map(); // termId -> first line of the last answer
  const listeners = new Set();
  let lastReport = '';
  let on = false;

  const clean = (s, n = 140) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

  function fire() { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } }

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
      const text = clean(s.text);
      const prev = states.get(id);
      const next = { state, text, tool, ask, since: prev && prev.state === state ? prev.since : Date.now() };
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
    const line = clean(String(text || '').split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').trim()).find(Boolean) || '', 120);
    if (answers.get(id) === line) return;
    answers.set(id, line);
    fire();
  }

  const EMPTY = { state: '', text: '', tool: null, ask: null, since: 0 };
  function get(id) { return states.get(String(id)) || EMPTY; }

  // A tool call the way Claude Code writes it: Bash(npm test), Read(src/app.js).
  function call(name, summary) {
    if (!name) return '';
    const arg = (summary || '').replace(/^\$ /, '');
    return arg ? `${name}(${arg})` : name;
  }

  function words(id) {
    const s = get(id);
    switch (s.state) {
      case 'needs': {
        const what = s.ask?.tool ? `Allow ${call(s.ask.tool, s.ask.summary)}?` : s.text && !/^Needs permission/.test(s.text) ? s.text : s.tool?.name ? `Allow ${call(s.tool.name, s.tool.summary)}?` : '';
        return `Needs you${what ? ' · ' + what : ''}`;
      }
      case 'working': {
        const what = s.tool?.name ? call(s.tool.name, s.tool.summary) : '';
        return `Working${what ? ' · ' + what : ''}`;
      }
      case 'done': {
        const a = answers.get(String(id));
        return `Done${a ? ' · ' + a : ''}`;
      }
      case 'idle': return 'Idle';
      default: return '';
    }
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

  function report(view) {
    const next = view && view.on
      ? { type: 'chats', on: true, onScreen: String(view.onScreen || ''), order: (view.order || []).map(String).slice(0, 200) }
      : { type: 'chats', on: false };
    const key = JSON.stringify(next);
    if (key === lastReport) return;
    lastReport = key;
    const was = on;
    on = !!next.on;
    if (was && !on) { states.clear(); answers.clear(); fire(); }
    wb.toHost(next);
  }

  if (typeof wb !== 'undefined' && typeof wb.onHostCommand === 'function') wb.onHostCommand(onMission);
  return Object.freeze({ get, words, mark, onChange, report, lastAnswer: (id) => answers.get(String(id)) || '' });
})();
