// A tiny mock of the Anthropic Messages API for the e2e suite (streaming SSE only, 127.0.0.1).
// Point Meridian at it with ANTHROPIC_BASE_URL=<base> ANTHROPIC_API_KEY=test.
//
// Behaviour, decided from the request:
//  - output_config.format (Tidy Today): a JSON plan grouping the first two tabs, renaming the third;
//  - the link-preview system prompt: a fixed summary;
//  - tools present and the last user turn isn't a tool result: one `list_tabs` tool call;
//  - otherwise: "Mock answer: <question>".
// Every request body is kept in `requests` for assertions.

const http = require('http');

function sse(res, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/[\s\S]{1,24}/g) || ['']) ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev('message_stop', {});
  res.end();
}

const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

function respond(body) {
  const last = body.messages?.[body.messages.length - 1];
  const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  if (body.output_config?.format) {
    const keys = [...textOf(last.content).matchAll(/^(t\d+)\t/gm)].map((m) => m[1]);
    return { blocks: [{ type: 'text', text: JSON.stringify({ folders: [{ name: 'Fixture Pages', tabs: keys.slice(0, 2) }], renames: keys[2] ? [{ tab: keys[2], title: 'Short Title' }] : [] }) }], stop: 'end_turn' };
  }
  if (/link-preview card/.test(system)) return { blocks: [{ type: 'text', text: 'A fixture page used by the Meridian tests. It says hello.' }], stop: 'end_turn' };
  const lastIsToolResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
  if (body.tools?.length && !lastIsToolResult) return { blocks: [{ type: 'text', text: 'Let me look at your tabs.' }, { type: 'tool_use', id: 'toolu_mock_1', name: 'list_tabs', input: {} }], stop: 'tool_use' };
  const q = textOf(last?.content).split('\n').pop() || '';
  return { blocks: [{ type: 'text', text: `Mock answer: ${q.slice(0, 80)}` }], stop: 'end_turn' };
}

async function startMockAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ url: req.url, headers: req.headers, body });
      // A key with "bad" in it is rejected (the power-up ceremony's key check).
      if (String(req.headers['x-api-key'] || req.headers.authorization || '').includes('bad')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      const { blocks, stop } = respond(body);
      setTimeout(() => sse(res, blocks, stop), 150);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = { startMockAnthropic };
