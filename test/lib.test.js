import test from 'node:test';
import assert from 'node:assert/strict';
import { documentModel, analyzeModel, generateDax, validateModel } from '../lib.js';
const model = { name: 'Retail', tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }], measures: [{ name: 'Revenue', expression: "SUM('Sales'[Amount])" }] }, { name: 'Dates', columns: [{ name: 'Date' }] }] };
test('documentation includes columns and measure expressions', () => { const docs = documentModel(model); assert.match(docs, /Amount \| decimal/); assert.match(docs, /SUM\('Sales'\[Amount\]\)/); });
test('analyzer identifies disconnected tables and risky relationships', () => { assert.equal(analyzeModel(model).filter(f => f.title.includes('disconnected')).length, 2); const linked = structuredClone(model); linked.relationships = [{ fromTable: 'Sales', fromColumn: 'Amount', toTable: 'Dates', toColumn: 'Date', cardinality: 'manyToMany', crossFilteringBehavior: 'bothDirections' }]; assert.equal(analyzeModel(linked).filter(f => f.severity === 'warning').length, 2); });
test('rejects malformed models and dangling relationship columns', () => { assert.throws(() => validateModel({ tables: [] })); assert.throws(() => validateModel({ tables: [{ name: 'A', columns: 'bad' }] })); assert.throws(() => validateModel({ ...model, relationships: [{ fromTable: 'Sales', fromColumn: 'Unknown', toTable: 'Dates', toColumn: 'Date' }] })); });
test('DAX supports all templates and escapes identifiers', () => { assert.equal(generateDax({ template: 'sum', table: "O'Brien", column: 'A]B' }).expression, "Total = SUM('O''Brien'[A]]B])"); assert.match(generateDax({ template: 'count', table: 'Sales' }).expression, /COUNTROWS/); assert.match(generateDax({ template: 'distinct', table: 'Sales', column: 'Amount' }).expression, /DISTINCTCOUNT/); assert.match(generateDax({ template: 'ytd', table: 'Sales', column: 'Amount', dateTable: 'Dates', dateColumn: 'Date' }).expression, /TOTALYTD/); assert.throws(() => generateDax({ template: 'ytd', table: 'Sales', column: 'Amount' })); });
test('expanded DAX recipes bind declared types and require actual date metadata', () => {
  const typed = { tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }, { name: 'Label', dataType: 'string' }] }, { name: 'Dates', columns: [{ name: 'Date', dataType: 'dateTime' }] }] };
  const input = { table: 'Sales', column: 'Amount', dateTable: 'Dates', dateColumn: 'Date', model: typed };
  for (const [template, fragment] of [['average', 'AVERAGE'], ['min', 'MIN'], ['max', 'MAX'], ['share', 'DIVIDE'], ['previous-month', 'MONTH'], ['yoy', 'PreviousValue'], ['rolling30', 'DATESINPERIOD']]) assert.ok(generateDax({ ...input, template }).expression.includes(fragment));
  assert.throws(() => generateDax({ ...input, column: 'Label', template: 'average' }), /numeric/);
  assert.throws(() => generateDax({ ...input, dateColumn: 'Missing', template: 'yoy' }), /declared date/);
  assert.throws(() => generateDax({ ...input, table: 'Invented', template: 'sum' }), /active model/);
});
