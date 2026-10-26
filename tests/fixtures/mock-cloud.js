// A tiny mock of the OpenAI-compatible APIs (OpenAI, Gemini, OpenRouter, …) for the e2e suite (127.0.0.1).
// Point Meridian at it with MERIDIAN_CLOUD_BASE=<base>: provider <id> lives under <base>/<id>.
//
//  - GET  /<id>/models: a model list per provider; keys containing "bad" get 401;
//  - POST /<id>/chat/completions: a streamed "Mock <id> (<model>): <question>".
// Every request is kept in `requests` ({ provider, path, auth, body }) for assertions.

const http = require('http');

const MODELS = {
  openai: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.1-mini', 'gpt-5.1', 'text-embedding-3-small', 'whisper-1', 'dall-e-3'],
  gemini: ['models/gemini-2.5-flash', 'models/gemini-3-flash', 'models/gemini-3-pro', 'models/text-embedding-004'],
  openrouter: ['openrouter/auto', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5.1'],
  xai: ['grok-4', 'grok-4-fast'],
  mistral: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-embed'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'whisper-large-v3'],
};

function startMockCloud() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const [, provider, ...rest] = req.url.split('?')[0].split('/');
      const route = '/' + rest.join('/');
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
      requests.push({ provider, path: route, auth, body, headers: req.headers });
      if (!MODELS[provider]) { res.writeHead(404); return res.end(); }
      if (!auth || /bad/.test(auth)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } })); }
      if (req.method === 'GET' && route === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: MODELS[provider].map((id) => ({ id, object: 'model' })) }));
      }
      if (req.method === 'POST' && route === '/chat/completions') {
        const q = String(body?.messages?.at(-1)?.content || '').split('\n').filter(Boolean).at(-1) || '';
        const text = `Mock ${provider} (${body?.model}): ${q}`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of text.match(/[\s\S]{1,12}/g)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, requests, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startMockCloud, MODELS };
