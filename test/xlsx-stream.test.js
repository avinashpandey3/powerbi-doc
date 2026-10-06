import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { importFile } from '../importers.js';
import { documentModel } from '../lib.js';
import { readXlsx } from '../xlsx-import.js';

// Reuse ExcelJS's pinned ZIP writer solely to construct small compressed test
// uploads, without building hundreds of thousands of ExcelJS cell objects.
const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip');
const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const columns = table => Object.fromEntries(table.columns.map(column => [column.name, column.dataType]));

function columnName(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function headerXml(names) {
  return `<row r="1">${names.map((name, index) => `<c r="${columnName(index)}1" t="inlineStr"><is><t>${name}</t></is></c>`).join('')}</row>`;
}

async function workbookWithSheetXml(sheetXml) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').addRow(['Placeholder']);
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('streamed XLSX imports more than 250,000 actual cells and 20 MB expanded XML', async () => {
  const names = Array.from({ length: 42 }, (_, index) => `Field${index + 1}`);
  const rows = [headerXml(names)];
  const rawValue = 'anonymous-metadata-inference-value';
  for (let row = 2; row <= 6001; row++) {
    rows.push(`<row r="${row}">${names.map((_, index) => `<c r="${columnName(index)}${row}" t="inlineStr"><is><t>${rawValue}</t></is></c>`).join('')}</row>`);
  }
  const xml = `<worksheet xmlns="${namespace}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  assert.ok(42 * 6000 > 250_000);
  assert.ok(Buffer.byteLength(xml) > 20_000_000);
  const upload = await workbookWithSheetXml(xml);
  assert.ok(upload.length < 10_000_000, 'compressed upload fits the default limit');
  const result = await importFile(upload, 'larger-workbook.xlsx');
  assert.equal(result.model.tables[0].rowCount, 6000);
  assert.equal(result.model.tables[0].sampledRowCount, 5000);
  assert.equal(result.model.tables[0].headerRow, 1);
  assert.equal(result.model.tables[0].dataTypeInferred, true);
  assert.equal(result.model.tables[0].columns.length, 42);
  assert.ok(result.model.tables[0].columns.every(column => column.dataType === 'string'));
  assert.ok(result.warnings.some(warning => /first.*5[,.]?000|sampl/i.test(warning)));
  assert.equal(JSON.stringify(result.model).includes(rawValue), false);
  const reimported = await importFile(Buffer.from(JSON.stringify(result.model)), 'exported-metadata.json');
  assert.deepEqual(reimported.model, result.model);
  const documentation = documentModel(reimported.model);
  assert.match(documentation, /Column types inferred from 5,000 of 6,000 data rows/);
  assert.match(documentation, /Later rows were not used for type inference/);
});

test('huge merged ranges do not allocate implied cells and produce an import warning', async () => {
  const xml = `<worksheet xmlns="${namespace}"><sheetData>${headerXml(['Id', 'Amount'])}<row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2"><v>12</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>`;
  const result = await importFile(await workbookWithSheetXml(xml), 'merged-layout.xlsx');
  assert.equal(result.model.tables[0].rowCount, 1);
  assert.deepEqual(columns(result.model.tables[0]), { Id: 'string', Amount: 'int64' });
  assert.ok(result.warnings.some(warning => /merged/i.test(warning)));
});

test('sparse last-row data is counted without creating empty rows or formatted columns', async () => {
  const xml = `<worksheet xmlns="${namespace}"><dimension ref="A1:XFD1048576"/><cols><col min="16384" max="16384" width="10" customWidth="1"/></cols><sheetData>${headerXml(['Id', 'Amount'])}<row r="1048576"><c r="A1048576" t="inlineStr"><is><t>009</t></is></c><c r="B1048576"><v>3.5</v></c><c r="XFD1048576" s="0"/></row></sheetData></worksheet>`;
  const result = await importFile(await workbookWithSheetXml(xml), 'sparse.xlsx');
  assert.equal(result.model.tables[0].rowCount, 1);
  assert.deepEqual(columns(result.model.tables[0]), { Id: 'string', Amount: 'decimal' });
});

test('sampled XLSX inference still counts every data row beyond the former 50,000-row limit', async () => {
  const rows = [headerXml(['Value'])];
  for (let row = 2; row <= 51_002; row++) {
    const cell = row <= 5001 ? `<c r="A${row}"><v>7</v></c>` : `<c r="A${row}" t="inlineStr"><is><t>after-sample-text</t></is></c>`;
    rows.push(`<row r="${row}">${cell}</row>`);
  }
  const xml = `<worksheet xmlns="${namespace}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const result = await importFile(await workbookWithSheetXml(xml), 'many-rows.xlsx');
  assert.equal(result.model.tables[0].rowCount, 51_001);
  assert.deepEqual(columns(result.model.tables[0]), { Value: 'int64' });
  assert.ok(result.warnings.some(warning => /first.*5[,.]?000|sampl/i.test(warning)));
  assert.equal(JSON.stringify(result.model).includes('after-sample-text'), false);
});

test('streamed XLSX preserves cached formula types, booleans, date styles, identifier formats, and sheets', async () => {
  const workbook = new ExcelJS.Workbook();
  const facts = workbook.addWorksheet('Facts');
  facts.addRow(['Id', 'Amount', 'Active', 'Date', 'Cached', 'Missing']);
  facts.addRow([9, 12.5, true, new Date('2024-02-29T00:00:00Z'), { formula: 'B2*2', result: 25 }, { formula: 'NOW()' }]);
  facts.getCell('A2').numFmt = '00000';
  facts.addRow([10, 3, false, new Date('2024-03-01T00:00:00Z'), { formula: 'B3*2', result: 6 }, null]);
  const lookup = workbook.addWorksheet('Lookup', { state: 'hidden' });
  lookup.addRow(['Code', 'Label']);
  lookup.addRow(['001', 'anonymous-display-value']);
  workbook.addWorksheet('Empty');
  const result = await importFile(await workbook.xlsx.writeBuffer(), 'types-and-sheets.xlsx');
  assert.deepEqual(result.model.tables.map(table => table.name), ['Facts', 'Lookup']);
  assert.deepEqual(columns(result.model.tables[0]), { Id: 'string', Amount: 'decimal', Active: 'boolean', Date: 'dateTime', Cached: 'int64', Missing: 'string' });
  assert.equal(result.model.tables[0].rowCount, 2);
  assert.equal(result.model.tables[1].rowCount, 1);
  assert.ok(result.warnings.some(warning => /formula.*not.*execut|not.*execut.*formula/i.test(warning)));
  assert.ok(result.warnings.some(warning => /cached result/i.test(warning)));
  assert.ok(result.warnings.some(warning => /Empty/.test(warning)));
  assert.ok(result.warnings.some(warning => /hidden/i.test(warning)));
  const serialized = JSON.stringify(result.model);
  assert.equal(serialized.includes('anonymous-display-value'), false);
  assert.equal(serialized.includes('NOW()'), false);
  assert.equal(serialized.includes('B2*2'), false);
});

test('report titles above the tabular header are skipped with an explanatory warning', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Report');
  sheet.addRow(['Quarterly report']);
  sheet.addRow([]);
  sheet.addRow(['Id', 'Amount']);
  sheet.addRow(['001', 3.5]);
  const result = await importFile(await workbook.xlsx.writeBuffer(), 'report-title.xlsx');
  assert.equal(result.model.tables[0].rowCount, 1);
  assert.equal(result.model.tables[0].headerRow, 3);
  assert.deepEqual(columns(result.model.tables[0]), { Id: 'string', Amount: 'decimal' });
  assert.ok(result.warnings.some(warning => /preamble|title|preced|before.*header|skipp.*header|header.*row 3/i.test(warning)));
  assert.equal(JSON.stringify(result.model).includes('Quarterly report'), false);
});

test('streamed XLSX rejects out-of-range physical coordinates and malformed worksheet XML', async () => {
  const outside = `<worksheet xmlns="${namespace}"><sheetData>${headerXml(['Value'])}<row r="1048577"><c r="A1048577"><v>1</v></c></row></sheetData></worksheet>`;
  await assert.rejects(importFile(await workbookWithSheetXml(outside), 'outside.xlsx'), /row|coordinate|range/i);
  const malformed = `<worksheet xmlns="${namespace}"><sheetData>${headerXml(['Value'])}<row r="2"><c r="A2"><v>1</v></row></sheetData></worksheet>`;
  await assert.rejects(importFile(await workbookWithSheetXml(malformed), 'malformed.xlsx'), /XML|workbook|worksheet|matching|tag/i);
});

test('streamed workbook XML rejects excessive nesting and oversized lexical tokens', async () => {
  const data = `<sheetData>${headerXml(['Value'])}<row r="2"><c r="A2"><v>1</v></c></row></sheetData>`;
  const nested = `<worksheet xmlns="${namespace}">${'<wrapper>'.repeat(129)}${data}${'</wrapper>'.repeat(129)}</worksheet>`;
  await assert.rejects(importFile(await workbookWithSheetXml(nested), 'deep-xml.xlsx'), /XML.*(?:depth|nest)|(?:depth|nest).*XML/i);
  const contents = [
    `<metadata><![CDATA[${'<'.repeat(1_000_001)}]]></metadata>`,
    `<!--${'<'.repeat(1_000_001)}-->`,
    `<metadata value="${'>'.repeat(1_000_001)}"/>`,
  ];
  for (const content of contents) {
    const oversized = `<worksheet xmlns="${namespace}">${data}${content}</worksheet>`;
    await assert.rejects(importFile(await workbookWithSheetXml(oversized), 'oversized-token.xlsx'), /oversized.*XML|XML.*(?:value|token|size)/i);
  }
});

test('streaming preserves a configurable archive expansion bound', async () => {
  const xml = `<worksheet xmlns="${namespace}"><sheetData>${headerXml(['Value'])}<row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>`;
  const upload = await workbookWithSheetXml(xml);
  await assert.rejects(readXlsx(upload, {
    headersFor: values => values.map(value => String(value)),
    valueType: value => typeof value === 'number' ? 'int64' : 'string',
    mergeType: (current, next) => current || next,
    maxExpandedBytes: 100,
  }), /processing limit|expand/i);
});

test('streamed worksheets reject repeated XML parts and incorrect part roots', async () => {
  const workbook = new ExcelJS.Workbook();
  for (const name of ['First', 'Second']) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(['Id']); sheet.addRow([1]);
  }
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const relPath = 'xl/_rels/workbook.xml.rels';
  const relationships = await zip.file(relPath).async('string');
  assert.match(relationships, /worksheets\/sheet2\.xml/);
  zip.file(relPath, relationships.replace('worksheets/sheet2.xml', 'worksheets/sheet1.xml'));
  await assert.rejects(importFile(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'repeated-part.xlsx'), /same XML part|duplicate.*part/i);
  const wrongRoot = `<metadata xmlns="${namespace}"><sheetData>${headerXml(['Value'])}<row r="2"><c r="A2"><v>1</v></c></row></sheetData></metadata>`;
  await assert.rejects(importFile(await workbookWithSheetXml(wrongRoot), 'wrong-root.xlsx'), /invalid XML part|root/i);
});

test('streamed worksheet data must match the archive checksum', async () => {
  const xml = `<worksheet xmlns="${namespace}"><sheetData>${headerXml(['Value'])}<row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>`;
  const upload = Buffer.from(await workbookWithSheetXml(xml));
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let patched = false;
  for (let cursor = upload.indexOf(centralSignature); cursor !== -1; cursor = upload.indexOf(centralSignature, cursor + 4)) {
    const nameLength = upload.readUInt16LE(cursor + 28);
    const name = upload.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name !== 'xl/worksheets/sheet1.xml') continue;
    upload.writeUInt32LE((upload.readUInt32LE(cursor + 16) ^ 1) >>> 0, cursor + 16);
    patched = true;
    break;
  }
  assert.equal(patched, true);
  await assert.rejects(importFile(upload, 'corrupt-checksum.xlsx'), /checksum/i);
});
