// Smoke test of the MCP bridge: starts the given command as a stdio MCP server, sends initialize,
// tools/list and one tools/call (which, without a running Meridian, must answer with an error
// text, not crash). Usage: node mcp-smoke.mjs <command> [args...]
import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {}
  }
});
p.on('exit', (code) => { console.error(`server exited (${code})`); process.exit(1); });
const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const call = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); });
const fail = (msg) => { console.error(msg); process.exit(1); };
setTimeout(() => fail('timeout'), 20000).unref();

const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0' } });
if (!init.result?.serverInfo?.name) fail(`initialize: ${JSON.stringify(init)}`);
send({ method: 'notifications/initialized' });
const list = await call(2, 'tools/list', {});
const tools = list.result?.tools || [];
if (!tools.length) fail(`tools/list: ${JSON.stringify(list)}`);
const res = await call(3, 'tools/call', { name: tools[0].name, arguments: {} });
if (!res.result?.content?.[0]?.text) fail(`tools/call: ${JSON.stringify(res)}`);
console.log(`${init.result.serverInfo.name} ${init.result.serverInfo.version}: ${tools.length} tools; ${tools[0].name} -> ${res.result.content[0].text.slice(0, 80)}`);
p.removeAllListeners('exit');
p.kill();
process.exit(0);
