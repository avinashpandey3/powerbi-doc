import test from 'node:test';
import assert from 'node:assert/strict';
import { combineModels } from '../public/import-model.js';
const source = {
  name: 'Retail', tables: [{ name: 'Sales', columns: [{ name: 'Id' }] }, { name: 'Customers', columns: [{ name: 'Id' }] }],
  relationships: [{ fromTable: 'Sales', fromColumn: 'Id', toTable: 'Customers', toColumn: 'Id' }]
};
test('combines files and remaps relationship endpoints when table names conflict', () => {
  const { model, warnings } = combineModels([source, source]);
  assert.deepEqual(model.tables.map(t => t.name), ['Sales', 'Customers', 'Sales_2', 'Customers_2']);
  assert.equal(model.relationships[1].fromTable, 'Sales_2');
  assert.equal(model.relationships[1].toTable, 'Customers_2');
  assert.equal(warnings.length, 2);
  assert.equal(source.tables.length, 2);
});
test('append preserves existing metadata and isolates source models', () => {
  const existing = { ...source, description: 'Keep this description.' };
  const { model } = combineModels([{ tables: [{ name: 'sales', columns: [{ name: 'Amount' }] }] }], { existing, mode: 'append' });
  assert.equal(model.description, existing.description);
  assert.equal(model.tables[2].name, 'sales_2');
  assert.equal(model.relationships.length, 1);
  model.tables[0].columns[0].name = 'Changed';
  assert.equal(source.tables[0].columns[0].name, 'Id');
});
test('renaming metadata tables warns about DAX references while preserving expression text', () => {
  const input = structuredClone(source);
  input.tables[0].measures = [{ name: 'Rows', expression: "COUNTROWS('Sales')" }];
  const result = combineModels([source, input]);
  assert.equal(result.model.tables[2].measures[0].expression, "COUNTROWS('Sales')");
  assert.ok(result.warnings.some(warning => warning.includes('DAX expressions were not rewritten')));
});
