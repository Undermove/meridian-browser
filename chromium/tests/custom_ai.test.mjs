// The person's own OpenAI-compatible server (a company gateway, Together, vLLM…) answering Ask:
// Settings › AI › Your own server takes its address (even the whole /chat/completions endpoint) and
// key, checks them with the server's model list, then it answers with the model picked. An http://
// address on the internet is refused (the key would travel in the clear); a server on this computer
// needs no "this goes to…" question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const KEY = 'team-key-123';

function server() {
  const requests = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: ['meta-llama/Llama-4-70B', 'qwen3-coder', 'bge-embedding-large'].map((id) => ({ id })) }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['Team server ', `(${json.model}) says hi`]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ server: s, requests, base: `http://127.0.0.1:${s.address().port}` })));
}

test('your own OpenAI-compatible server: address and key checked, a model picked, it answers; http on the internet refused', async () => {
  const api = await server();
  const b = await launch(['about:blank'], { args: ['--meridian-test-ai-consent'] });
  const settings = () => b.eval(`${H}.getSettings().then(({settings}) => settings)`);
  const openAi = async () => {
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('customBase')`);
    // Folded under "Your own server" until one is connected.
    await b.eval(`${ST}.getElementById('customFold').open = true`);
  };
  const connect = async (base, key) => {
    await b.eval(`(() => { ${ST}.getElementById('customBase').value = ${JSON.stringify(base)}; ${ST}.getElementById('customKey').value = ${JSON.stringify(key)}; return true; })()`);
    // (At the bottom of a small window: in sight first.)
    await b.eval(`${ST}.getElementById('saveCustom').scrollIntoView({ block: 'center' }), true`);
    await b.click(`${ST}.getElementById('saveCustom')`);
  };
  const message = `${ST}.getElementById('keyMessage').textContent`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await openAi();

    // http:// on the internet: refused before anything is sent.
    await connect('http://api.example.com/v1', KEY);
    await b.waitFor(`${message}.includes('Use an https:// address')`);
    assert.equal(api.requests.length, 0);
    // Not an address.
    await connect('my server', KEY);
    await b.waitFor(`${message}.includes('isn’t an API address')`);

    // The wrong key: the server's answer.
    const endpoint = `${api.base}/v1/chat/completions`;
    await connect(endpoint, 'wrong');
    await b.waitFor(`${message}.includes('didn’t accept this key')`);
    assert.equal((await settings()).aiProvider, '', 'nothing saved');

    // The right one (the whole endpoint pasted): connected, chosen, its chat models offered.
    await connect(endpoint, KEY);
    await b.waitFor(`${message}.includes('Connected to 127.0.0.1')`);
    assert.equal((await settings()).aiProvider, 'custom');
    assert.equal((await b.eval(`${H}.getCustomAi()`)).baseUrl, `${api.base}/v1`);
    await b.waitFor(`${ST}.getElementById('ai-custom')?.textContent.includes('your OpenAI-compatible server')`);
    await b.waitFor(`${ST}.querySelector('select.model[data-id="custom"]')?.options.length === 3`);
    const options = await b.eval(`[...${ST}.querySelector('select.model[data-id="custom"]').options].map((o) => o.value)`);
    assert.deepEqual(options, ['', 'meta-llama/Llama-4-70B', 'qwen3-coder'], 'no embedding model');
    await b.eval(`(() => { const s = ${ST}.querySelector('select.model[data-id="custom"]'); s.value = 'qwen3-coder'; s.dispatchEvent(new Event('change')); return true; })()`);
    await b.eval('app.$.settings.hide()');

    // ⌘J: the server answers with that model; on this computer, so no "this goes to…" question.
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'hello'; ${AK}.getElementById('send').click(); return true; })()`);
    await b.waitFor(`${AK}.textContent.includes('Team server (qwen3-coder) says hi')`);
    assert.ok(!(await b.eval('app.$.aiConsent.open')), 'no question for a server on this computer');
    const sent = api.requests.filter((r) => r.url === '/v1/chat/completions').pop();
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent.body.model, 'qwen3-coder');

    // Removed: gone, address forgotten.
    await openAi();
    const remove = `[...${ST}.querySelectorAll('button[data-id="custom"]')].find((e) => e.textContent.trim() === 'Remove')`;
    await b.eval(`(${remove}).scrollIntoView({ block: 'center' }), true`);
    await b.click(remove);
    await b.waitFor(`!${ST}.getElementById('ai-custom')`, 8000).catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await b.eval(`[${ST}.getElementById('keyMessage').textContent, [...${ST}.querySelectorAll('button[data-id]')].map((x) => x.dataset.id + ':' + x.textContent.trim()), ${H}.getCustomAi()]`)));
    });
    assert.equal((await b.eval(`${H}.getCustomAi()`)).baseUrl, '');
  } finally {
    await b.close();
    api.server.close();
  }
});
