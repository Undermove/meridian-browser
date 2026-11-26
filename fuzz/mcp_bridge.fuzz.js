// The MCP bridge (mcp/meridian-mcp.js) reads JSON-RPC from whatever MCP client started it, and the
// answers of the browser on the other side. This feeds both with fuzzer bytes through the real stdio
// transport and checks the bridge stays a well-behaved JSON-RPC peer: no crash, no unhandled
// rejection, and every line it writes is one JSON-RPC 2.0 message.
const { PassThrough, Writable } = require('stream');
const { FuzzedDataProvider } = require('@jazzer.js/core');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('../mcp/meridian-mcp.js');

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '1' } } }) + '\n';
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n';

const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

module.exports.fuzz = async function (data) {
  const fdp = new FuzzedDataProvider(data);
  // What "the browser" answers: any JSON value, or a failed request.
  const answer = fdp.consumeBoolean() ? parse(fdp.consumeString(fdp.consumeIntegralInRange(0, 512), 'utf-8')) : undefined;
  const call = async () => { if (answer === undefined) throw new Error('not running'); return answer; };
  const handshake = fdp.consumeBoolean();
  const piece = fdp.consumeIntegralInRange(1, 1024);
  const input = Buffer.from(fdp.consumeRemainingAsBytes());

  const out = [];
  const stdin = new PassThrough();
  const stdout = new Writable({ write(chunk, _enc, cb) { out.push(chunk.toString('utf8')); cb(); } });
  const server = createServer(call);
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  if (handshake) { stdin.write(INIT); stdin.write(INITIALIZED); }
  // In pieces of a fuzzer-chosen size, the way a pipe delivers them (a message split mid-character too).
  for (let at = 0; at < input.length; at += piece) stdin.write(input.subarray(at, at + piece));
  await settle();
  await server.close();

  for (const line of out.join('').split('\n')) {
    if (!line) continue;
    const msg = JSON.parse(line); // throws (a finding) if the bridge wrote something that isn't JSON
    if (!msg || msg.jsonrpc !== '2.0') throw new Error(`not a JSON-RPC 2.0 message: ${line.slice(0, 200)}`);
  }
};
