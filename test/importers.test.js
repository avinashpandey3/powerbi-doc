import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { importFile, MAX_FILE_BYTES, MAX_ROWS, MAX_COLUMNS, MAX_CELLS } from '../importers.js';

const bytes = value => Buffer.from(value);
const types = table => Object.fromEntries(table.columns.map(column => [column.name, column.dataType]));

test('CSV handles BOM, quoted delimiters, escaped quotes and multiline fields without storing records', async () => {
  const result = await importFile(bytes('\uFEFFId,Note,Amount,Active,Date\r\n001,"first, second\nthird ""line""",12.5,true,2024-02-29\r\n002,end,8,false,2024-03-01\r\n'), 'sales.CSV');
  assert.equal(result.format, 'csv');
  assert.equal(result.model.tables[0].rowCount, 2);
  assert.deepEqual(types(result.model.tables[0]), { Id: 'string', Note: 'string', Amount: 'decimal', Active: 'boolean', Date: 'dateTime' });
  assert.equal(JSON.stringify(result.model).includes('first, second'), false);
  assert.equal(JSON.stringify(result.model).includes('001'), false);
  assert.ok(result.warnings.some(warning => /inferred/.test(warning)));
});

test('TSV and delimited TXT detect their separators and reject prose', async () => {
  const tsv = await importFile(bytes('Name\tCount\nA\t4\n'), 'items.tsv');
  assert.deepEqual(types(tsv.model.tables[0]), { Name: 'string', Count: 'int64' });
  for (const delimiter of [';', '|', '\t', ',']) {
    const txt = await importFile(bytes(`Id${delimiter}Flag\n007${delimiter}TRUE\n`), 'items.txt');
    assert.deepEqual(types(txt.model.tables[0]), { Id: 'string', Flag: 'boolean' });
  }
  await assert.rejects(importFile(bytes('Some prose without a table'), 'notes.txt'), /Delimited \.txt/);
  const semicolonCsv = await importFile(bytes('Id;Amount\nA;12.5\n'), 'regional.csv');
  assert.deepEqual(types(semicolonCsv.model.tables[0]), { Id: 'string', Amount: 'decimal' });
});

test('CSV requires unique complete headers and matching row widths', async () => {
  await assert.rejects(importFile(bytes('Name,,Age\nA,B,3'), 'bad.csv'), /Headers must be nonempty/);
  await assert.rejects(importFile(bytes('Name, Name \nA,B'), 'bad.csv'), /unique/);
  await assert.rejects(importFile(bytes('Name,Age\nA,3,extra'), 'bad.csv'), /Invalid delimited file/);
  await assert.rejects(importFile(bytes('Name,Age\n"unterminated,3'), 'bad.csv'), /Invalid delimited file/);
  await assert.rejects(importFile(bytes(' \n'), 'empty.csv'), /empty/);
  const headerOnly = await importFile(bytes('Id,Amount\n'), 'empty-table.csv');
  assert.equal(headerOnly.model.tables[0].rowCount, 0);
});

test('record inference unions fields and treats mixed, null, invalid dates, and zero-prefixed values conservatively', async () => {
  const input = [
    { Id: '009', Number: 2, Mixed: true, Empty: null, Date: '2024-02-30', ValidDate: '2024-02-29', Long: '9223372036854775808', Optional: null },
    { Id: '010', Number: 2.5, Mixed: 'n/a', Empty: '', Date: '2023-02-29', ValidDate: '2024-03-01T23:59:59Z', Long: '1', Later: 'hello' },
  ];
  const result = await importFile(bytes(JSON.stringify(input)), 'records.json');
  assert.deepEqual(types(result.model.tables[0]), {
    Id: 'string', Number: 'decimal', Mixed: 'string', Empty: 'string', Date: 'string', ValidDate: 'dateTime', Long: 'string', Optional: 'string', Later: 'string',
  });
  assert.equal(result.model.tables[0].rowCount, 2);
  assert.equal(JSON.stringify(result.model).includes('hello'), false);
});

test('JSON rows/data wrappers import records, preserve hostile field names safely, and report nested fields', async () => {
  for (const key of ['rows', 'data']) {
    const result = await importFile(bytes(JSON.stringify({ [key]: [{ A: 1 }, { A: 2 }] })), 'wrapped.json');
    assert.equal(result.model.tables[0].rowCount, 2);
  }
  const hostile = await importFile(bytes('[{"__proto__":"safe","constructor":1,"Nested":{"secret":"discard"}}]'), 'hostile.json');
  assert.deepEqual(types(hostile.model.tables[0]), { ['__proto__']: 'string', constructor: 'int64', Nested: 'string' });
  assert.ok(hostile.warnings.some(warning => /Nested/.test(warning)));
  assert.equal(JSON.stringify(hostile.model).includes('discard'), false);
  await assert.rejects(importFile(bytes('{"rows":[{"A":1}],"data":[{"B":2}]}'), 'ambiguous.json'), /either rows or data/);
  await assert.rejects(importFile(bytes('[1,2,3]'), 'primitives.json'), /Each record must be an object/);
  await assert.rejects(importFile(bytes('[]'), 'empty.json'), /nonempty array/);
  await assert.rejects(importFile(bytes('[{"A":1," A ":2}]'), 'duplicate.json'), /unique/);
});

test('normalized JSON metadata keeps measures and relationships while omitting raw records and source queries', async () => {
  const input = { name: 'Model', dataSources: [{ password: 'discard' }], tables: [
    { name: 'Sales', columns: [{ name: 'CustomerId', dataType: 'int64', isHidden: true }], measures: [{ name: 'Rows', expression: 'COUNTROWS(Sales)' }], rows: [{ secret: 'discard' }], partitions: [{ source: 'discard' }] },
    { name: 'Customers', columns: [{ name: 'Id', dataType: 'int64' }] },
  ], relationships: [{ fromTable: 'Sales', fromColumn: 'CustomerId', toTable: 'Customers', toColumn: 'Id', cardinality: 'manyToOne', crossFilteringBehavior: 'oneDirection' }] };
  const result = await importFile(bytes(JSON.stringify(input)), 'metadata.json');
  assert.equal(result.format, 'json');
  assert.equal(result.model.tables[0].measures[0].expression, 'COUNTROWS(Sales)');
  assert.equal(result.model.tables[0].columns[0].isHidden, true);
  assert.equal(result.model.relationships[0].cardinality, 'manyToOne');
  assert.equal(JSON.stringify(result.model).includes('discard'), false);
  assert.deepEqual(result.warnings, []);
});

test('BIM unwraps the tabular model and derives cardinality from both relationship ends', async () => {
  const input = { name: 'Database', compatibilityLevel: 1600, model: { tables: [
    { name: 'Fact', columns: [{ name: 'Key', dataType: 'int64' }], measures: [{ name: 'Total', expression: ['SUM(Fact[Key])', '+ 1'] }] },
    { name: 'Dimension', columns: [{ name: 'Key', dataType: 'int64' }] },
  ], relationships: [{ fromTable: 'Fact', fromColumn: 'Key', toTable: 'Dimension', toColumn: 'Key', fromCardinality: 'many', toCardinality: 'one', crossFilteringBehavior: 'bothDirections' }] } };
  const result = await importFile(bytes(JSON.stringify(input)), 'retail.bim');
  assert.equal(result.format, 'bim');
  assert.equal(result.model.relationships[0].cardinality, 'manyToOne');
  assert.equal(result.model.relationships[0].fromCardinality, 'many');
  assert.equal(result.model.tables[0].measures[0].expression, 'SUM(Fact[Key])\n+ 1');
  assert.equal((await importFile(bytes(JSON.stringify(input)), 'tabular.json')).format, 'bim');
  await assert.rejects(importFile(bytes('[{"A":1}]'), 'not-a-model.bim'), /Tabular model/);
});

test('exporting and reimporting inferred metadata preserves row counts without raw records', async () => {
  const first = await importFile(bytes('Id,Amount\n001,12\n002,24\n'), 'source.csv');
  const second = await importFile(bytes(JSON.stringify(first.model)), 'export.json');
  assert.deepEqual(second.model, first.model);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"Bad","rowCount":-1}]}'), 'bad.json'), /rowCount must be a nonnegative safe integer/);
});

test('malformed metadata returns helpful validation errors', async () => {
  await assert.rejects(importFile(bytes('{"tables":[null]}'), 'bad.json'), /table must be an object/);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"A","columns":[{"name":"Id"},{"name":"Id"}]}]}'), 'bad.json'), /unique/);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"A","columns":false}]}'), 'bad.json'), /columns must be an array/);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"A","columns":[{"name":"Id"}]}],"relationships":[{"fromTable":"A","toTable":"Missing"}]}'), 'bad.json'), /existing tables/);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"A","description":{"rows":[{"secret":"private"}]}}]}'), 'nested.json'), /description must be text/);
  await assert.rejects(importFile(bytes('{"tables":[{"name":"A","columns":[{"name":"Id","dataType":{"secret":"private"}}]}]}'), 'nested.json'), /dataType must be text/);
});

test('JSONL supports blank lines and BOM and identifies malformed lines without leaking content', async () => {
  const result = await importFile(bytes('\uFEFF{"Id":"001","Value":2}\n\n{"Id":"002","Value":3.5}\n'), 'records.ndjson');
  assert.equal(result.format, 'jsonl');
  assert.deepEqual(types(result.model.tables[0]), { Id: 'string', Value: 'decimal' });
  await assert.rejects(importFile(bytes('{"A":1}\n{"private-data":oops}\n'), 'bad.jsonl'), error => /line 2/.test(error.message) && !error.message.includes('private-data'));
  await assert.rejects(importFile(bytes('{"A":1}\n[]'), 'bad.jsonl'), /line 2 must be an object/);
});

test('flat XML imports repeated records, decodes standard entities, and preserves identifiers', async () => {
  const result = await importFile(bytes('<?xml version="1.0"?><rows><row><Id>001</Id><Amount>12.5</Amount><Active>true</Active><Note>A &amp; B</Note></row><row><Id>002</Id><Amount>7</Amount><Active>false</Active><Note>C</Note></row></rows>'), 'rows.xml');
  assert.equal(result.format, 'xml');
  assert.equal(result.model.tables[0].rowCount, 2);
  assert.deepEqual(types(result.model.tables[0]), { Id: 'string', Amount: 'decimal', Active: 'boolean', Note: 'string' });
  assert.equal(JSON.stringify(result.model).includes('A & B'), false);
});

test('XML rejects malformed, nested, attributed, multiple-root, and DTD documents', async () => {
  await assert.rejects(importFile(bytes('<rows><row><Id>1</row></rows>'), 'bad.xml'), /Invalid XML/);
  await assert.rejects(importFile(bytes('<rows><row><Address><City>A</City></Address></row></rows>'), 'nested.xml'), /Flatten nested/);
  await assert.rejects(importFile(bytes('<rows><row id="1"><Name>A</Name></row></rows>'), 'attributes.xml'), /Flatten nested/);
  await assert.rejects(importFile(bytes('<a/><b/>'), 'roots.xml'), /Invalid XML|one root/);
  await assert.rejects(importFile(bytes('<!DOCTYPE rows [<!ENTITY private "secret">]><rows><row><Id>&private;</Id></row></rows>'), 'entity.xml'), /DTDs and custom entities/);
  await assert.rejects(importFile(bytes('<rows><row><Id>&private;</Id></row></rows>'), 'unknown-entity.xml'), /custom entities are unsupported/);
});

test('XLSX imports nonempty worksheets and cached formula metadata without executing formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.addRow(['Id', 'Amount', 'Active', 'Date', 'Calculated', 'Uncached']);
  sales.addRow(['001', 12.5, true, new Date('2024-02-29T00:00:00Z'), { formula: 'B2*2', result: 25 }, { formula: 'NOW()' }]);
  sales.addRow(['002', 3, false, new Date('2024-03-01T00:00:00Z'), { formula: 'B3*2', result: 6 }, null]);
  const customers = workbook.addWorksheet('Customers');
  customers.addRow(['Code', 'Name']); customers.addRow([9, 'Alice']);
  customers.getCell('A2').numFmt = '00000';
  workbook.addWorksheet('Empty');
  const result = await importFile(await workbook.xlsx.writeBuffer(), 'retail.xlsx');
  assert.equal(result.format, 'xlsx');
  assert.equal(result.model.tables.length, 2);
  assert.deepEqual(types(result.model.tables[0]), { Id: 'string', Amount: 'decimal', Active: 'boolean', Date: 'dateTime', Calculated: 'int64', Uncached: 'string' });
  assert.equal(types(result.model.tables[1]).Code, 'string');
  assert.ok(result.warnings.some(warning => /not executed/.test(warning)));
  assert.ok(result.warnings.some(warning => /1 formula cell\(s\) have no cached result/.test(warning)));
  assert.ok(result.warnings.some(warning => /1 empty worksheet\(s\) skipped: Empty/.test(warning)));
  assert.equal(JSON.stringify(result.model).includes('Alice'), false);
});

test('XLSX rejects blank headers, excessive sparse rows, empty and corrupt workbooks', async () => {
  const incomplete = new ExcelJS.Workbook(), sheet = incomplete.addWorksheet('Rows');
  sheet.addRow(['Id', null]); sheet.addRow([1, 2]);
  await assert.rejects(importFile(await incomplete.xlsx.writeBuffer(), 'bad.xlsx'), /Headers must be nonempty/);
  const sparse = new ExcelJS.Workbook(), distant = sparse.addWorksheet('Rows');
  distant.getCell('A1').value = 'Id'; distant.getCell(`A${MAX_ROWS + 2}`).value = 1;
  await assert.rejects(importFile(await sparse.xlsx.writeBuffer(), 'sparse.xlsx'), /row indexes|data rows/);
  const wide = new ExcelJS.Workbook(), formatted = wide.addWorksheet('Rows');
  formatted.getCell('A1').value = 'Id'; formatted.getColumn(MAX_COLUMNS + 1).width = 12;
  await assert.rejects(importFile(await wide.xlsx.writeBuffer(), 'wide.xlsx'), /512 columns/);
  const empty = new ExcelJS.Workbook(); empty.addWorksheet('Empty');
  await assert.rejects(importFile(await empty.xlsx.writeBuffer(), 'empty.xlsx'), /no nonempty worksheets/);
  await assert.rejects(importFile(bytes('not a workbook'), 'bad.xlsx'), /Invalid \.xlsx/);
});

test('compressed XLSX expansion is bounded before workbook parsing', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Large');
  sheet.addRow(['Text']);
  const repeated = 'a'.repeat(4000);
  for (let index = 0; index < 5100; index++) sheet.addRow([`${index}:${repeated}`]);
  const zipped = await workbook.xlsx.writeBuffer();
  assert.ok(zipped.length < MAX_FILE_BYTES, 'compressed upload fits the ordinary file limit');
  await assert.rejects(importFile(zipped, 'expanded.xlsx'), /20 MB processing limit/);
});

test('XLSX rejects merged ranges above cell or column limits before expansion', async () => {
  const cells = new ExcelJS.Workbook(), cellSheet = cells.addWorksheet('Merged');
  cellSheet.getCell('A1').value = 'Id';
  // Provide a merged-cell model directly, without expanding the fixture's range.
  const originalGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cellSheet), 'model').get;
  let endpoint = `SR${Math.ceil(MAX_CELLS / MAX_COLUMNS) + 1}`;
  Object.defineProperty(cellSheet, 'model', { get() {
    const model = originalGetter.call(cellSheet);
    model.rows[0].cells.push({ address: 'A2', type: ExcelJS.ValueType.Merge, master: endpoint });
    return model;
  } });
  await assert.rejects(importFile(await cells.xlsx.writeBuffer(), 'merged-cells.xlsx'), /250,000 cells/);
  endpoint = 'SS2';
  await assert.rejects(importFile(await cells.xlsx.writeBuffer(), 'merged-columns.xlsx'), /512 columns/);
});

test('byte, row, column, encoding, and unsupported-format limits fail clearly', async () => {
  await assert.rejects(importFile(Buffer.alloc(MAX_FILE_BYTES + 1), 'large.csv'), /at most 2 MB/);
  await assert.rejects(importFile(bytes(`Id\n${'1\n'.repeat(MAX_ROWS + 1)}`), 'large.csv'), /50,000 data rows/);
  await assert.rejects(importFile(bytes(`${Array.from({ length: MAX_COLUMNS + 1 }, (_, index) => `C${index}`).join(',')}\n`), 'wide.csv'), /512 columns/);
  await assert.rejects(importFile(Buffer.from([0xff, 0xfe, 0x61]), 'utf16.csv'), /UTF-8/);
  await assert.rejects(importFile(Buffer.from([0x61, 0, 0x62]), 'binary.json'), /binary content/);
  await assert.rejects(importFile(bytes('content'), 'report.pbix'), /Export the semantic model/);
  await assert.rejects(importFile(bytes('content'), 'old.xls'), /Save the workbook as \.xlsx/);
  await assert.rejects(importFile(bytes('content'), 'picture.png'), /Unsupported file format/);
});
