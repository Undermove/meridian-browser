/* Meridian Studio — reads a Claude Code session's transcript (JSONL, one event per line) into what
 * the Studio chat shows: turns (the person's message, then Claude's text and steps in order), the
 * files the session created or changed, the pictures it took, and the plan it is following.
 * Pure: no DOM, no `window.workbench`; unknown or broken lines are skipped. Node tests require it.
 */
(function (root) {
  'use strict';

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
  const MAX_SHOTS = 8;

  function newModel() {
    return { turns: [], files: new Map(), shots: [], plan: null, sessionId: '', pending: new Map(), seen: new Set(), title: '' };
  }

  // A user message that is the person's own words (not a command's output, a hook's note or a
  // tool's result).
  function promptText(msg) {
    const c = msg?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b?.type === 'tool_result')) return '';
      text = c.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
    }
    text = String(text).trim();
    if (!text) return '';
    if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|user-memory-input)/.test(text)) return '';
    if (/^Caveat: The messages below were generated/.test(text)) return '';
    if (/^\[Request interrupted/.test(text)) return '';
    return text;
  }

  function inside(path, rootDir) {
    if (!path || !rootDir) return '';
    const p = String(path), r = String(rootDir).replace(/\/+$/, '');
    if (p === r || !p.startsWith(r + '/')) return '';
    const rel = p.slice(r.length + 1);
    return rel.split('/').includes('..') ? '' : rel;
  }

  function resultText(block) {
    const c = block?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n');
    return '';
  }

  function resultImages(block) {
    const c = block?.content;
    if (!Array.isArray(c)) return [];
    return c.filter((x) => x?.type === 'image' && x.source?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(x.source.media_type || '') && typeof x.source.data === 'string')
      .map((x) => `data:${x.source.media_type};base64,${x.source.data}`);
  }

  function lastTurn(m) {
    if (!m.turns.length) m.turns.push({ prompt: '', at: 0, items: [] });
    return m.turns[m.turns.length - 1];
  }

  // Adds the lines of `text` (whole lines) to the model `m`; returns true if anything changed.
  function feed(m, text, { root: rootDir = '' } = {}) {
    let changed = false;
    for (const line of String(text || '').split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.isSidechain) continue; // a helper's own work: its parent's step says it
      if (ev.uuid) { if (m.seen.has(ev.uuid)) continue; m.seen.add(ev.uuid); }
      if (typeof ev.sessionId === 'string' && ev.sessionId) m.sessionId = ev.sessionId;
      if (ev.type === 'summary' && typeof ev.summary === 'string') { m.title = ev.summary; changed = true; continue; }
      if (ev.type === 'custom-title' && typeof ev.customTitle === 'string') { m.title = ev.customTitle; changed = true; continue; }
      const at = Date.parse(ev.timestamp || '') || 0;
      const msg = ev.message;
      if (ev.type === 'user' && msg) {
        if (ev.isMeta) continue;
        const prompt = promptText(msg);
        if (prompt) {
          m.turns.push({ prompt, at, items: [] });
          changed = true;
          continue;
        }
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b?.type !== 'tool_result') continue;
            const step = m.pending.get(b.tool_use_id);
            if (!step) continue;
            m.pending.delete(b.tool_use_id);
            const out = resultText(b);
            step.state = b.is_error ? (/doesn't want to proceed|was rejected|denied|not allowed/i.test(out) ? 'denied' : 'error') : 'ok';
            step.endedAt = at;
            if (!b.is_error) {
              for (const src of resultImages(b)) {
                m.shots.push({ src, step: step.id, at, label: step.label || '' });
                if (m.shots.length > MAX_SHOTS) m.shots.shift();
              }
              // A file counts once the tool changed it.
              if (step.file) {
                const prev = m.files.get(step.file.rel);
                m.files.set(step.file.rel, { rel: step.file.rel, abs: step.file.abs, created: prev ? prev.created : step.file.created, at, image: IMAGE_EXT.test(step.file.rel), times: (prev?.times || 0) + 1 });
              }
            }
            changed = true;
          }
        }
        continue;
      }
      if (ev.type === 'assistant' && msg && Array.isArray(msg.content)) {
        const turn = lastTurn(m);
        for (const b of msg.content) {
          if (b?.type === 'text' && String(b.text || '').trim()) {
            turn.items.push({ type: 'text', text: String(b.text).trim(), at });
            changed = true;
          } else if (b?.type === 'tool_use' && b.id) {
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            const step = { type: 'step', id: b.id, tool: String(b.name || ''), input, state: 'running', at };
            const path = input.file_path || input.notebook_path;
            if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(step.tool) && typeof path === 'string') {
              const rel = inside(path, rootDir);
              if (rel) step.file = { rel, abs: path, created: step.tool === 'Write' };
            }
            if (step.tool === 'TodoWrite' && Array.isArray(input.todos)) {
              m.plan = input.todos.filter((t) => t && typeof t.content === 'string')
                .map((t) => ({ text: t.content, active: t.activeForm || t.content, status: t.status || 'pending' }));
            }
            m.pending.set(b.id, step);
            // Steps that follow each other go in one list.
            const prev = turn.items[turn.items.length - 1];
            if (prev?.type === 'steps') prev.steps.push(step);
            else turn.items.push({ type: 'steps', steps: [step], at });
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  // Where the plan is: "step 2 of 3" and what is being done now.
  function planProgress(plan) {
    if (!Array.isArray(plan) || !plan.length) return null;
    const i = plan.findIndex((t) => t.status === 'in_progress');
    const done = plan.filter((t) => t.status === 'completed').length;
    return { index: i >= 0 ? i + 1 : Math.min(done + 1, plan.length), total: plan.length, now: i >= 0 ? plan[i].active : '', done };
  }

  // The sites the session went to (browser tools, web fetches), newest last.
  function sitesOf(m) {
    const out = [];
    for (const t of m.turns) for (const it of t.items) {
      if (it.type !== 'steps') continue;
      for (const s of it.steps) {
        const url = s.input?.url;
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          try { const u = new URL(url); if (!out.includes(u.href)) out.push(u.href); } catch {}
        }
      }
    }
    return out;
  }

  const api = { newModel, feed, planProgress, sitesOf, promptText, inside };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StudioTranscript = api;
})(typeof window !== 'undefined' ? window : globalThis);
