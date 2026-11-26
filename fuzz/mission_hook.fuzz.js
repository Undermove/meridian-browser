// The Mission Control hook (src/agents/hooks/mission-hook.js) gets the coding agent's hook event
// JSON (which carries tool inputs: commands, paths, URLs) and passes on only a few short fields.
// It must not throw on any JSON, and what it sends must stay small, whatever the input.
const { FuzzedDataProvider } = require('@jazzer.js/core');
const { fromClaude, fromCodex } = require('../src/agents/hooks/mission-hook.js');

const EVENT_KEYS = ['hook_event_name', 'tool_name', 'tool_input', 'cwd', 'session_id', 'agent_id', 'agent_type', 'tool_use_id', 'source', 'reason', 'trigger', 'notification_type', 'message', 'model', 'duration_ms', 'is_interrupt'];
const INPUT_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'description', 'subagent_type', 'run_in_background', 'todos', 'skill'];
const TOOLS = ['Bash', 'BashOutput', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill', 'mcp__srv__tool'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionStart'];

function value(fdp, depth) {
  switch (fdp.consumeIntegralInRange(0, 6)) {
    case 0: return fdp.consumeString(fdp.consumeIntegralInRange(0, 600), 'utf-8');
    case 1: return fdp.consumeNumber();
    case 2: return fdp.consumeBoolean();
    case 3: return null;
    case 4: return depth > 2 ? [] : Array.from({ length: fdp.consumeIntegralInRange(0, 4) }, () => value(fdp, depth + 1));
    case 5: return depth > 2 ? {} : object(fdp, INPUT_KEYS, depth + 1);
    default: return fdp.consumeString(fdp.consumeIntegralInRange(0, 40), 'ascii');
  }
}
function object(fdp, keys, depth) {
  const o = {};
  for (let n = fdp.consumeIntegralInRange(0, 8); n > 0 && fdp.remainingBytes; n--) {
    const key = fdp.consumeIntegralInRange(0, 9) ? keys[fdp.consumeIntegralInRange(0, keys.length - 1)] : fdp.consumeString(16, 'utf-8');
    o[key] = value(fdp, depth);
  }
  return o;
}

function event(fdp) {
  const ev = object(fdp, EVENT_KEYS, 0);
  if (fdp.consumeBoolean()) ev.tool_name = TOOLS[fdp.consumeIntegralInRange(0, TOOLS.length - 1)];
  if (fdp.consumeBoolean()) ev.hook_event_name = EVENTS[fdp.consumeIntegralInRange(0, EVENTS.length - 1)];
  if (fdp.consumeBoolean()) ev.tool_input = object(fdp, INPUT_KEYS, 1);
  return JSON.parse(JSON.stringify(ev)); // as it arrives: JSON
}

module.exports.fuzz = function (data) {
  const fdp = new FuzzedDataProvider(data);
  let line;
  switch (fdp.consumeIntegralInRange(0, 2)) {
    case 0: line = fromCodex(fdp.consumeRemainingAsString()); break; // Codex: the event is an argv string
    case 1: {
      let ev;
      try { ev = JSON.parse(fdp.consumeRemainingAsString()); } catch { return; }
      if (!ev || typeof ev !== 'object') return; // main() stops there
      line = fromClaude(ev);
      break;
    }
    default: line = fromClaude(event(fdp));
  }
  for (const [k, v] of Object.entries(line)) {
    if (v === undefined || typeof v === 'boolean' || typeof v === 'number') continue;
    if (typeof v !== 'string') throw new Error(`${k} is a ${typeof v}`);
    if (v.length > 300) throw new Error(`${k} is ${v.length} characters long`);
  }
  JSON.stringify(line);
};
