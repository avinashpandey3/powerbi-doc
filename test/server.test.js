import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('hosted server serves health, UI, and model tools on an assigned port', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill(); await stopped;
    }
  });
  const port = await new Promise((resolve, reject) => {
    let output = '', error = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on 0\.0\.0\.0 port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on('data', chunk => error += chunk);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited (${code}): ${error}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Understand your model/);
  const model = { tables: [{ name: 'Sales', columns: [{ name: 'Amount' }] }] };
  const cases = [
    ['docs', model, result => assert.match(result, /### Sales/)],
    ['analyze', model, result => assert.equal(result[0].title, 'Sales: missing description')],
    ['dax', { template: 'sum', table: 'Sales', column: 'Amount' }, result => assert.equal(result.expression, "Total = SUM('Sales'[Amount])")]
  ];
  for (const [path, input, check] of cases) {
    const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200); check((await response.json()).result);
  }
  const imported = await fetch(`${base}/api/import?filename=sales.csv`, { method: 'POST', body: 'Id,Amount\n001,12.50\n002,20.00' });
  assert.equal(imported.status, 200);
  const metadata = (await imported.json()).result.model;
  assert.equal(metadata.tables[0].columns[0].dataType, 'string');
  const docs = await fetch(`${base}/api/docs`, { method: 'POST', body: JSON.stringify(metadata) });
  assert.equal(docs.status, 200);
  assert.match((await docs.json()).result, /Amount/);
  const malformed = await fetch(`${base}/api/import?filename=broken.json`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, 'string');
  const unsupported = await fetch(`${base}/api/import?filename=model.pbix`, { method: 'POST', body: 'not a pbix' });
  assert.equal(unsupported.status, 400);
  const oversized = await fetch(`${base}/api/import?filename=large.csv`, { method: 'POST', body: 'A'.repeat(2_000_001) });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /2 MB/);
  const module = await fetch(`${base}/import-model.js`);
  assert.equal(module.status, 200);
});
