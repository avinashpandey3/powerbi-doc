import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('configured assistant requires the private token and forwards filtered metadata to an Ollama-compatible server', { timeout: 10000 }, async t => {
  let forwarded;
  const provider = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/chat');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: "Revenue = SUM('Sales'[Amount])\n\nThis measure uses the current filter context." } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', AI_PROVIDER: 'ollama', OLLAMA_MODEL: 'doctor-test', OLLAMA_BASE_URL: `http://127.0.0.1:${provider.address().port}`, AI_ACCESS_TOKEN: 'test-assistant-access' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  });
  const port = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on 127\.0\.0\.1 port (\d+)/); if (match) resolve(Number(match[1])); });
    child.stderr.on('data', chunk => errors += chunk);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited (${code}): ${errors}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.ai.configured, true);
  assert.equal(config.ai.accessRequired, true);
  assert.equal(JSON.stringify(config).includes('test-assistant-access'), false);
  const input = { mode: 'dax', prompt: 'Create a revenue measure', model: { name: 'Retail', tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }], rows: [{ private: 'source-record-secret' }], partitions: [{ password: 'source-password-secret' }] }] } };
  const denied = await fetch(`${base}/api/assistant`, { method: 'POST', body: JSON.stringify(input) });
  assert.equal(denied.status, 401);
  assert.equal(forwarded, undefined);
  const response = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Token': 'test-assistant-access' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.match(result.text, /Revenue = SUM/);
  assert.match(result.notice, /not live retrieval/);
  assert.equal(result.provider, 'ollama');
  const context = JSON.stringify(forwarded);
  assert.match(context, /Amount/);
  assert.equal(context.includes('source-record-secret'), false);
  assert.equal(context.includes('source-password-secret'), false);
  assert.equal(context.includes('test-assistant-access'), false);
});
