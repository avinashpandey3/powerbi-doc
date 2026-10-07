import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, dashboardMarkdown } from '../dashboard.js';

const salesModel = () => ({ name: 'Sales model', tables: [{ name: 'Sales', columns: [
  { name: 'CustomerID', dataType: 'int64', isKey: true }, { name: 'Amount', dataType: 'decimal' },
  { name: 'Category', dataType: 'string' }, { name: 'Date', dataType: 'dateTime' },
], measures: [{ name: 'Revenue', expression: "SUM('Sales'[Amount])" }] }], relationships: [] });

function assertBindings(plan, model) {
  const findTable = name => model.tables.find(table => table.name === name);
  const fieldExists = binding => assert.ok(findTable(binding.table)?.columns.some(column => column.name === binding.column), `unknown field ${binding.table}.${binding.column}`);
  for (const page of plan.pages) {
    for (const binding of page.slicers) fieldExists(binding);
    for (const visual of page.visuals) {
      assert.ok(findTable(visual.table));
      if (visual.category) fieldExists(visual.category);
      if (visual.value) fieldExists(visual.value);
      if (visual.measure) assert.ok(findTable(visual.measure.table)?.measures.some(measure => measure.name === visual.measure.name));
      for (const binding of visual.fields || []) fieldExists(binding);
      const { x, y, width, height } = visual.position;
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= page.layout.width && y + height <= page.layout.height);
    }
  }
}

test('dashboard blueprint uses real field bindings, preserves existing measures, and stays deterministic', () => {
  const model = salesModel();
  const plan = buildDashboard({ model, brief: 'Revenue by category over time', title: 'Trading overview' });
  assertBindings(plan, model);
  assert.equal(plan.source, 'rules');
  assert.equal(plan.title, 'Trading overview');
  assert.deepEqual(plan, buildDashboard({ model, brief: 'Revenue by category over time', title: 'Trading overview' }));
  const card = plan.pages[0].visuals.find(visual => visual.type === 'card');
  assert.deepEqual(card.measure, { table: 'Sales', name: 'Revenue' });
  assert.equal(card.aggregation, undefined);
  assert.equal(card.suggestedDax, undefined);
  assert.ok(plan.pages[0].visuals.some(visual => visual.type === 'line' && visual.category.column === 'Date'));
  assert.ok(!JSON.stringify(plan).includes('CustomerID = SUM'));
  assert.ok(plan.warnings.some(warning => /schematic/.test(warning)));
  assert.ok(!('data' in plan.pages[0].visuals[0]));
});

test('numeric identifiers and textual measures fall back to honest row-count metrics', () => {
  const model = { tables: [{ name: 'Locations', columns: [{ name: 'SA3 Code', dataType: 'int64' }, { name: 'Postcode', dataType: 'int64' }, { name: 'Name', dataType: 'string' }], measures: [{ name: 'Label', expression: 'FORMAT(123, "0")', dataType: 'string' }] }] };
  const plan = buildDashboard({ model });
  assertBindings(plan, model);
  const card = plan.pages[0].visuals.find(visual => visual.type === 'card');
  assert.equal(card.aggregation, 'countRows');
  assert.equal(card.suggestedDax, "Dashboard Row Count = COUNTROWS('Locations')");
  assert.ok(!plan.pages[0].visuals.some(visual => visual.value));
});

test('suggested DAX escapes actual table and column names and averages rates', () => {
  const model = { tables: [{ name: "Owner's data", columns: [{ name: 'Rate]Percent', dataType: 'double' }, { name: 'Area', dataType: 'string' }] }] };
  const plan = buildDashboard({ model });
  assertBindings(plan, model);
  const card = plan.pages[0].visuals.find(visual => visual.type === 'card');
  assert.equal(card.aggregation, 'average');
  assert.ok(card.suggestedDax.includes("AVERAGE('Owner''s data'[Rate]]Percent])"));
  assert.ok(plan.warnings.some(warning => /weighting/.test(warning)));
});

test('date charts use only same-table dates or confirmed active relationships', () => {
  const model = salesModel();
  model.tables[0].columns = model.tables[0].columns.filter(column => column.name !== 'Date');
  model.tables.push({ name: 'Calendar', columns: [{ name: 'DateKey', dataType: 'int64' }, { name: 'Date', dataType: 'dateTime' }] });
  model.tables[0].columns.push({ name: 'DateKey', dataType: 'int64' });
  model.relationships = [{ fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Calendar', toColumn: 'DateKey', cardinality: 'manyToOne', isActive: false }];
  assert.ok(!buildDashboard({ model }).pages[0].visuals.some(visual => visual.type === 'line'));
  model.relationships[0].isActive = true;
  const connected = buildDashboard({ model });
  assertBindings(connected, model);
  assert.ok(connected.pages[0].visuals.some(visual => visual.type === 'line' && visual.category.table === 'Calendar'));
  assert.ok(!JSON.stringify(connected).includes('TOTALYTD'));
  model.relationships[0].cardinality = 'manyToMany';
  assert.ok(!buildDashboard({ model }).pages[0].visuals.some(visual => visual.type === 'line'));
});

test('hidden fields are excluded and disconnected tables get independent pages', () => {
  const model = salesModel();
  model.tables[0].columns.push({ name: 'Secret', dataType: 'decimal', isHidden: true });
  model.tables.push({ name: 'Other', columns: [{ name: 'Region', dataType: 'string' }, { name: 'Population', dataType: 'int64' }], measures: [] });
  model.tables.push({ name: 'Hidden', isHidden: true, columns: [{ name: 'HiddenMetric', dataType: 'decimal' }] });
  const plan = buildDashboard({ model });
  assertBindings(plan, model);
  assert.equal(plan.pages.length, 2);
  for (const page of plan.pages) for (const visual of page.visuals) if (visual.category) assert.equal(visual.category.table, visual.table);
  assert.ok(!JSON.stringify(plan).includes('Secret'));
  assert.ok(!JSON.stringify(plan).includes('HiddenMetric'));
  assert.ok(plan.warnings.some(warning => /No active relationships/.test(warning)));
});

test('themes contain supported Power BI root fields and guides describe the exact plan', () => {
  for (const style of ['midnight', 'violet', 'light', 'slate']) {
    const plan = buildDashboard({ model: salesModel(), style });
    assert.deepEqual(Object.keys(plan.theme).sort(), ['background', 'dataColors', 'foreground', 'name', 'tableAccent']);
    for (const color of [...plan.theme.dataColors, plan.theme.background, plan.theme.foreground, plan.theme.tableAccent]) assert.match(color, /^#[A-Fa-f0-9]{6}$/);
    const guide = dashboardMarkdown(plan);
    assert.ok(guide.includes('Revenue'));
    assert.ok(guide.includes('1440 × 900'));
    assert.ok(guide.includes('does not create or publish a PBIX'));
  }
  assert.throws(() => buildDashboard({ model: salesModel(), style: 'unknown' }), /Unknown dashboard style/);
  assert.throws(() => buildDashboard({ model: salesModel(), brief: 123 }), /brief must be text/);
});

test('table limit is explicit and names from the brief only prioritize existing fields', () => {
  const model = { tables: Array.from({ length: 10 }, (_, index) => ({ name: `Table ${index}`, columns: [{ name: 'Amount', dataType: 'decimal' }] })) };
  const plan = buildDashboard({ model, brief: 'Completely invented RevenueForecast not in this model' });
  assert.equal(plan.pages.length, 8);
  assertBindings(plan, model);
  assert.ok(plan.warnings.some(warning => /additional table/.test(warning)));
  assert.ok(plan.pages.every(page => page.visuals.every(visual => !visual.measure)));
});

test('Deneb specs bind actual fields and never re-aggregate existing measures', () => {
  const model = salesModel();
  const plan = buildDashboard({ model, style: 'violet' });
  const chart = plan.pages[0].visuals.find(visual => visual.type === 'bar');
  assert.equal(chart.denebSpec.data.name, 'dataset');
  assert.equal(chart.denebSpec.encoding.x.field, 'Revenue');
  assert.equal(chart.denebSpec.encoding.x.aggregate, undefined);
  assert.equal(chart.denebSpec.encoding.y.field, 'Category');
  assert.equal(chart.denebSpec.mark.color, plan.theme.dataColors[0]);
  assert.deepEqual(chart.denebFields, [{ table: 'Sales', column: 'Category', role: 'category' }, { table: 'Sales', measure: 'Revenue', role: 'value' }]);
  const source = { tables: [{ name: 'Source', columns: [{ name: 'Value.Amount', dataType: 'decimal' }, { name: 'Category[Name]', dataType: 'string' }] }] };
  const raw = buildDashboard({ model: source }).pages[0].visuals.find(visual => visual.type === 'bar');
  assert.equal(raw.denebSpec.encoding.x.field, 'Value\\.Amount');
  assert.equal(raw.denebSpec.encoding.x.aggregate, 'sum');
  assert.equal(raw.denebSpec.encoding.y.field, 'Category\\[Name\\]');
  const keys = { tables: [{ name: 'Keys', columns: [{ name: 'ID', dataType: 'int64' }, { name: 'Area', dataType: 'string' }] }] };
  const countPlan = buildDashboard({ model: keys });
  assert.ok(countPlan.pages[0].visuals.every(visual => !visual.denebSpec));
  assert.ok(countPlan.warnings.some(warning => /COUNTROWS measure/.test(warning)));
});
