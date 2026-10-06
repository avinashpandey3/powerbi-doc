import test from 'node:test';
import assert from 'node:assert/strict';
import { getLimits } from '../limits.js';
import { importFile, MAX_FILE_BYTES } from '../importers.js';

test('limits default to 10 MB uploads while model JSON and batch bounds stay fixed', () => {
  assert.deepEqual(getLimits({}), { maxUploadBytes: 10_000_000, maxModelBytes: 2_000_000, maxFiles: 10 });
});

test('MAX_UPLOAD_MB config accepts positive whole-number sizes independently of model limits', () => {
  for (const megabytes of ['1', '5', '25']) {
    assert.deepEqual(getLimits({ MAX_UPLOAD_MB: megabytes }), {
      maxUploadBytes: Number(megabytes) * 1_000_000,
      maxModelBytes: 2_000_000,
      maxFiles: 10,
    });
  }
});

test('MAX_UPLOAD_MB rejects invalid numbers and byte products outside the safe-integer range', () => {
  for (const invalid of ['0', '-1', '1.5', 'abc', '10MB', '1e3', 'NaN', 'Infinity', '9007199254740992', '9007199255']) {
    assert.throws(() => getLimits({ MAX_UPLOAD_MB: invalid }), /MAX_UPLOAD_MB/);
  }
});

test('CSV larger than the former 2 MB ceiling imports with ordinary row and column bounds', async () => {
  const row = `001,${'x'.repeat(128)}\n`;
  const input = Buffer.from(`Id,Text\n${row.repeat(20_000)}`);
  assert.ok(input.length > 2_000_000 && input.length < 10_000_000);
  if (input.length > MAX_FILE_BYTES) {
    // A deliberately smaller deployment limit still takes precedence.
    await assert.rejects(importFile(input, 'larger-data.csv'), /at most.*MB/i);
    return;
  }
  const result = await importFile(input, 'larger-data.csv');
  assert.equal(result.model.tables[0].rowCount, 20_000);
  assert.deepEqual(result.model.tables[0].columns, [{ name: 'Id', dataType: 'string' }, { name: 'Text', dataType: 'string' }]);
  assert.equal(JSON.stringify(result.model).includes('001'), false);
});

test('importer still rejects uploads above its configured byte limit before parsing', async () => {
  assert.equal(MAX_FILE_BYTES, getLimits().maxUploadBytes);
  await assert.rejects(importFile(Buffer.alloc(MAX_FILE_BYTES + 1), 'too-large.csv'), /at most.*MB/i);
});
