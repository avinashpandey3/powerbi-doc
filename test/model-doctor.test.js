import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectModel, reviewDax } from '../model-doctor.js';
import { documentHtml } from '../document-html.js';

const clean = { name: 'Retail', tables: [{ name: 'Sales', description: 'Transactions', columns: [{ name: 'Amount', dataType: 'decimal', description: 'Transaction value' }], measures: [{ name: 'Revenue', expression: "SUM('Sales'[Amount])", description: 'Total value' }] }] };
test('metadata health is explained, reproducible, and responds to real structural findings', () => {
  const healthy = inspectModel(clean);
  assert.equal(healthy.score, 100);
  assert.equal(healthy.counts.total, 0);
  assert.deepEqual(healthy.stats, { tables: 1, columns: 1, measures: 1, relationships: 0, describedColumns: 1, describedMeasures: 1 });
  const bad = structuredClone(clean);
  bad.tables[0].columns.push({ name: 'amount', dataType: 'decimal' });
  const result = inspectModel(bad);
  assert.equal(result.counts.critical, 1);
  assert.equal(result.score, 78);
  assert.match(result.scoreExplanation, /does not evaluate/);
});
test('metadata health flags sampled types and mismatched relationship keys', () => {
  const model = { tables: [
    { name: 'Fact', columns: [{ name: 'Key', dataType: 'int64' }], rowCount: 6000, sampledRowCount: 5000, dataTypeInferred: true },
    { name: 'Dimension', columns: [{ name: 'Key', dataType: 'string' }] },
  ], relationships: [{ fromTable: 'Fact', fromColumn: 'Key', toTable: 'Dimension', toColumn: 'Key' }] };
  const result = inspectModel(model);
  assert.ok(result.findings.some(finding => /sampled type/.test(finding.title)));
  assert.ok(result.findings.some(finding => /type mismatch/.test(finding.title)));
  assert.deepEqual(result.relationships, model.relationships);
  assert.ok(result.score >= 0 && result.score <= 100);
});
test('DAX review explains filters and division without claiming syntax validation', () => {
  const result = reviewDax({ expression: 'CALCULATE(SUM(Sales[Amount]), ALL(Sales)) / [Target]', model: clean });
  assert.ok(result.findings.some(finding => /Division/.test(finding.title)));
  assert.ok(result.findings.some(finding => /Filter context/.test(finding.title)));
  assert.match(result.notice, /No DAX syntax compilation/);
  assert.throws(() => reviewDax({ expression: '' }), /Paste/);
});
test('standalone documentation escapes HTML and retains metadata and DAX', () => {
  const model = structuredClone(clean);
  model.name = '<script>secret</script>';
  model.tables[0].description = '<img src=x onerror=alert(1)>';
  const html = documentHtml(model);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /SUM\(&#39;Sales&#39;\[Amount\]\)/);
  assert.match(html, /<table>/);
});
