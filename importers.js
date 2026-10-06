import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { validateModel } from './lib.js';

export const MAX_FILE_BYTES = 2_000_000;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 512;
export const MAX_CELLS = 250_000;
const MAX_TABLES = 128;
const MAX_EXPANDED_BYTES = 20_000_000;
const MAX_ZIP_ENTRY_BYTES = MAX_EXPANDED_BYTES;
const inferredWarnings = [
  'Column types are inferred from available values; review identifiers, dates, and mixed-type columns.',
  'Data files do not supply DAX measures or Power BI relationships. Add that metadata separately.',
];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function decodeText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Text files must use UTF-8 encoding. Convert the file to UTF-8 and try again.'); }
  if (text.includes('\0')) throw new Error('This file contains binary content. Upload UTF-8 text or an .xlsx workbook.');
  if (!text.trim()) throw new Error('The file is empty.');
  return text;
}

function headersFor(values) {
  if (!values.length) throw new Error('A table needs a nonempty header row.');
  if (values.length > MAX_COLUMNS) throw new Error(`A table can contain at most ${MAX_COLUMNS} columns.`);
  const seen = new Set();
  return values.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Headers must be nonempty text. Fill in every column header.');
    const name = value.trim();
    if (seen.has(name)) throw new Error('Column headers must be unique. Rename duplicate headers.');
    seen.add(name);
    return name;
  });
}

function dateText(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minutes, seconds, , , offsetHour, offsetMinute] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && (h === undefined || (Number(h) <= 23 && Number(minutes) <= 59 && Number(seconds || 0) <= 59))
    && (offsetHour === undefined || (Number(offsetHour) <= 14 && Number(offsetMinute) <= 59 && (Number(offsetHour) < 14 || Number(offsetMinute) === 0)));
}

function valueType(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'string' : 'dateTime';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isSafeInteger(value) ? 'int64' : 'decimal') : 'string';
  if (typeof value !== 'string') return 'string';
  const text = value.trim();
  if (!text) return null;
  if (/^(true|false)$/i.test(text)) return 'boolean';
  // Numeric-looking IDs retain their zeros, even when all rows have the same width.
  if (/^[+-]?0\d/.test(text)) return 'string';
  if (/^[+-]?\d+$/.test(text)) {
    try {
      const number = BigInt(text);
      return number >= -9223372036854775808n && number <= 9223372036854775807n ? 'int64' : 'string';
    } catch { return 'string'; }
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number.isFinite(Number(text)) ? 'decimal' : 'string';
  if (dateText(text)) return 'dateTime';
  return 'string';
}

function mergeType(current, next) {
  if (!next) return current;
  if (!current || current === next) return next;
  if ((current === 'int64' && next === 'decimal') || (current === 'decimal' && next === 'int64')) return 'decimal';
  return 'string';
}

function tableFromMatrix(name, headers, rows) {
  if (rows.length > MAX_ROWS) throw new Error(`A file can contain at most ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
  const types = Array(headers.length).fill(null);
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error('Every data row must have the same number of fields as the header.');
    for (let index = 0; index < headers.length; index++) types[index] = mergeType(types[index], valueType(row[index]));
  }
  return { name, rowCount: rows.length, columns: headers.map((header, index) => ({ name: header, dataType: types[index] || 'string' })), measures: [] };
}

function inferredResult(tables, filename, format, warnings = []) {
  return {
    model: validateModel({ name: path.basename(filename, path.extname(filename)) || 'Imported model', tables, relationships: [] }),
    warnings: [...inferredWarnings, ...warnings], format,
  };
}

function delimiterFor(text, format) {
  if (format === 'tsv') return '\t';
  const candidates = format === 'csv' ? [',', '\t', ';', '|'] : ['\t', ',', ';', '|'];
  let chosen = candidates[0], width = 0;
  for (const delimiter of candidates) {
    try {
      const first = parseCsv(text, { delimiter, to: 1, skip_empty_lines: true, max_record_size: MAX_FILE_BYTES })[0];
      if (first && first.length > width) { chosen = delimiter; width = first.length; }
      if (format === 'csv' && delimiter === ',' && width > 1) return ',';
    } catch { /* The full parse supplies a content-free error below. */ }
  }
  if (format === 'txt' && width < 2) throw new Error('Delimited .txt files need a header and comma, tab, semicolon, or pipe separators.');
  return chosen;
}

function importDelimited(bytes, filename, format) {
  const text = decodeText(bytes), delimiter = delimiterFor(text, format);
  let records, count = 0;
  try {
    records = parseCsv(text, {
      delimiter, skip_empty_lines: true, max_record_size: MAX_FILE_BYTES,
      on_record(record) {
        if (record.length > MAX_COLUMNS) throw new Error(`A table can contain at most ${MAX_COLUMNS} columns.`);
        if (++count > MAX_ROWS + 1) throw new Error(`A file can contain at most ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
        return record;
      },
    });
  } catch (error) {
    if (!error.code) throw error;
    throw new Error(`Invalid delimited file${Number.isInteger(error.lines) ? ` near line ${error.lines}` : ''}. Check quoting and ensure every row matches the header width.`);
  }
  if (!records.length) throw new Error('A table needs a nonempty header row.');
  const headers = headersFor(records.shift());
  return inferredResult([tableFromMatrix(path.basename(filename, path.extname(filename)), headers, records)], filename, format);
}

function tableFromRecords(rows, name) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Record data must be a nonempty array of objects.');
  if (rows.length > MAX_ROWS) throw new Error(`A file can contain at most ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
  const fields = new Map();
  for (const row of rows) {
    if (!isRecord(row)) throw new Error('Each record must be an object with named fields.');
    for (const [key, value] of Object.entries(row)) {
      if (!key.trim()) throw new Error('Record field names must be nonempty.');
      if (!fields.has(key)) fields.set(key, null);
      if (fields.size > MAX_COLUMNS) throw new Error(`A table can contain at most ${MAX_COLUMNS} columns.`);
      fields.set(key, mergeType(fields.get(key), valueType(value)));
    }
  }
  if (!fields.size) throw new Error('Records need at least one named field.');
  const keys = [...fields.keys()], headers = headersFor(keys);
  return { name, rowCount: rows.length, columns: headers.map((header, index) => ({ name: header, dataType: fields.get(keys[index]) || 'string' })), measures: [] };
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (!Object.hasOwn(object, key) || object[key] === null || object[key] === undefined) continue;
    let value = object[key];
    if (key === 'expression' && Array.isArray(value) && value.every(line => typeof line === 'string')) value = value.join('\n');
    const expected = ['isHidden', 'isKey', 'isActive'].includes(key) ? 'boolean' : 'string';
    if (typeof value !== expected) throw new Error(`Model metadata field ${key} must be ${expected === 'string' ? 'text' : 'a boolean'}.`);
    result[key] = value;
  }
  return result;
}

function metadataModel(input, filename, format) {
  if (!isRecord(input) || !Array.isArray(input.tables) || !input.tables.length) throw new Error('Model metadata must contain a nonempty tables array.');
  if (input.tables.length > MAX_TABLES) throw new Error(`Model metadata can contain at most ${MAX_TABLES} tables.`);
  const tables = input.tables.map(table => {
    if (!isRecord(table)) throw new Error('Each model table must be an object.');
    if (table.columns !== undefined && !Array.isArray(table.columns)) throw new Error('Table columns must be an array.');
    if (table.measures !== undefined && !Array.isArray(table.measures)) throw new Error('Table measures must be an array.');
    const columns = table.columns || [], measures = table.measures || [];
    if (columns.length > MAX_COLUMNS) throw new Error(`A table can contain at most ${MAX_COLUMNS} columns.`);
    const seen = new Set();
    const cleanedColumns = columns.map(column => {
      if (!isRecord(column) || typeof column.name !== 'string' || !column.name.trim()) throw new Error('Model columns need nonempty names.');
      if (seen.has(column.name)) throw new Error('Model column names must be unique within each table.');
      seen.add(column.name);
      return pick(column, ['name', 'dataType', 'description', 'isHidden', 'isKey', 'sourceColumn', 'formatString', 'expression', 'type', 'sortByColumn']);
    });
    const cleanedMeasures = measures.map(measure => {
      if (!isRecord(measure)) throw new Error('Each model measure must be an object.');
      const result = pick(measure, ['name', 'expression', 'description', 'formatString', 'isHidden', 'displayFolder']);
      return result;
    });
    const result = { ...pick(table, ['name', 'description', 'isHidden']), columns: cleanedColumns, measures: cleanedMeasures };
    if (Object.hasOwn(table, 'rowCount')) {
      if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) throw new Error('Table rowCount must be a nonnegative safe integer.');
      result.rowCount = table.rowCount;
    }
    return result;
  });
  if (input.relationships !== undefined && !Array.isArray(input.relationships)) throw new Error('Model relationships must be an array.');
  const relationships = (input.relationships || []).map(relationship => {
    if (!isRecord(relationship)) throw new Error('Each model relationship must be an object.');
    const result = pick(relationship, ['name', 'fromTable', 'fromColumn', 'toTable', 'toColumn', 'cardinality', 'fromCardinality', 'toCardinality', 'crossFilteringBehavior', 'isActive', 'securityFilteringBehavior']);
    if (!result.cardinality && result.fromCardinality && result.toCardinality) {
      const from = String(result.fromCardinality).toLowerCase(), to = String(result.toCardinality).toLowerCase();
      if (['one', 'many'].includes(from) && ['one', 'many'].includes(to)) result.cardinality = `${from}To${to[0].toUpperCase()}${to.slice(1)}`;
    }
    return result;
  });
  const model = { ...pick(input, ['name', 'description', 'culture']), name: input.name || path.basename(filename, path.extname(filename)), tables, relationships };
  return { model: validateModel(model), warnings: [], format };
}

function importJson(bytes, filename, extension) {
  let input;
  try { input = JSON.parse(decodeText(bytes)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Invalid JSON. Check the file syntax and try again.'); throw error; }
  if (isRecord(input) && Object.hasOwn(input, 'model')) return metadataModel(input.model, filename, 'bim');
  if (isRecord(input) && Object.hasOwn(input, 'tables')) return metadataModel(input, filename, extension === 'bim' ? 'bim' : 'json');
  if (extension === 'bim') throw new Error('A .bim file must contain a Tabular model with tables.');
  let rows = input;
  if (isRecord(input)) {
    if (Object.hasOwn(input, 'rows') && Object.hasOwn(input, 'data')) throw new Error('JSON record wrappers must contain either rows or data, not both.');
    rows = Object.hasOwn(input, 'rows') ? input.rows : input.data;
  }
  const table = tableFromRecords(rows, path.basename(filename, path.extname(filename)));
  const nested = rows.some(row => Object.values(row).some(value => value !== null && typeof value === 'object'));
  return inferredResult([table], filename, 'json', nested ? ['Nested JSON fields are represented as string columns; expand them into flat fields for more precise types.'] : []);
}

function importJsonLines(bytes, filename) {
  const rows = [], lines = decodeText(bytes).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { throw new Error(`Invalid JSON Lines record at line ${index + 1}. Each nonempty line must contain one JSON object.`); }
    if (!isRecord(row)) throw new Error(`JSON Lines record at line ${index + 1} must be an object with named fields.`);
    rows.push(row);
    if (rows.length > MAX_ROWS) throw new Error(`A file can contain at most ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
  }
  const table = tableFromRecords(rows, path.basename(filename, path.extname(filename)));
  const nested = rows.some(row => Object.values(row).some(value => value !== null && typeof value === 'object'));
  return inferredResult([table], filename, 'jsonl', nested ? ['Nested JSON fields are represented as string columns; expand them into flat fields for more precise types.'] : []);
}

function importXml(bytes, filename) {
  const text = decodeText(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('XML DTDs and custom entities are unsupported. Export a flat XML file without a DTD.');
  const markup = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)[A-Za-z_:][\w.:-]*;/.test(markup)) throw new Error('XML custom entities are unsupported. Use standard XML entities or plain text values.');
  const validation = XMLValidator.validate(text);
  if (validation !== true) throw new Error(`Invalid XML${Number.isInteger(validation.err?.line) ? ` near line ${validation.err.line}` : ''}. Check matching tags and quoting.`);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true });
  const document = parser.parse(text);
  const roots = Object.entries(document).filter(([key]) => !key.startsWith('?'));
  if (roots.length !== 1 || !isRecord(roots[0][1])) throw new Error('XML needs one root containing repeated record elements, such as <rows><row>...</row></rows>.');
  const root = roots[0][1];
  const recordElements = Object.entries(root).filter(([key, value]) => key !== '#text' || String(value).trim());
  if (recordElements.length !== 1 || recordElements[0][0].startsWith('@_')) throw new Error('XML needs one repeated record element inside its root. Attributes and multiple record types are unsupported.');
  const value = recordElements[0][1], rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!isRecord(row) || Object.entries(row).some(([key, field]) => key.startsWith('@_') || key === '#text' || typeof field === 'object')) {
      throw new Error('XML records must contain flat child elements with text values. Flatten nested elements, attributes, or repeated fields before importing.');
    }
  }
  return inferredResult([tableFromRecords(rows, path.basename(filename, path.extname(filename)))], filename, 'xml');
}

// Check real ZIP expansion before handing a workbook to ExcelJS. A small upload
// can otherwise inflate to a much larger workbook in memory.
function preflightXlsx(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('Invalid .xlsx workbook. Upload an unencrypted Excel .xlsx file.');
  const entries = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || entries !== bytes.readUInt16LE(end + 8) || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || entries > 2000 || centralOffset + centralSize !== end) {
    throw new Error('Unsupported workbook archive. Use a standard, unencrypted .xlsx file.');
  }
  let cursor = centralOffset, totalExpanded = 0, totalCells = 0;
  const names = new Set();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid .xlsx workbook archive.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid or encrypted .xlsx workbook archive.');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (names.has(name)) throw new Error('Invalid .xlsx workbook archive with duplicate entries.');
    names.add(name);
    if (expanded > MAX_ZIP_ENTRY_BYTES || totalExpanded + expanded > MAX_EXPANDED_BYTES) throw new Error('The workbook expands beyond the 20 MB processing limit. Export fewer rows or sheets.');
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (start + compressed > centralOffset) throw new Error('Invalid .xlsx workbook archive.');
    let contents;
    try { contents = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.min(MAX_ZIP_ENTRY_BYTES, MAX_EXPANDED_BYTES - totalExpanded) }); }
    catch { throw new Error('Invalid or oversized .xlsx workbook contents. Export fewer rows or sheets.'); }
    if (contents.length !== expanded) throw new Error('Invalid .xlsx workbook archive sizes.');
    totalExpanded += contents.length;
    if (totalExpanded > MAX_EXPANDED_BYTES) throw new Error('The workbook expands beyond the 20 MB processing limit. Export fewer rows or sheets.');
    // Reject sparse/out-of-range worksheet coordinates before ExcelJS can allocate rows.
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const xml = contents.toString('utf8');
      let rowElements = 0;
      for (const tag of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(row|col|c|mergeCell)\b[^>]*>/g)) {
        const attributes = new Map();
        for (const match of tag[0].matchAll(/\b(r|min|max|ref)\s*=\s*(["'])(.*?)\2/gs)) {
          if (match[3].includes('&')) throw new Error('Entity-encoded worksheet coordinates are unsupported. Resave the workbook in Excel and try again.');
          if (attributes.has(match[1])) throw new Error('Invalid duplicate worksheet coordinate attributes.');
          attributes.set(match[1], match[3]);
        }
        if (tag[1] === 'row') {
          if (++rowElements > MAX_ROWS + 1) throw new Error(`Worksheets can contain at most ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
          if (attributes.has('r') && (!/^\d+$/.test(attributes.get('r')) || Number(attributes.get('r')) > MAX_ROWS + 1)) throw new Error(`Worksheet row indexes must stay within ${MAX_ROWS + 1}. Remove distant formatted or populated rows.`);
        } else if (tag[1] === 'col') {
          for (const key of ['min', 'max']) if (attributes.has(key) && (!/^\d+$/.test(attributes.get(key)) || Number(attributes.get(key)) > MAX_COLUMNS)) throw new Error(`Worksheets can contain at most ${MAX_COLUMNS} columns. Remove distant formatted or populated columns.`);
        } else if (tag[1] === 'c') {
          totalCells++;
          if (attributes.has('r')) boundedCellReference(attributes.get('r'));
        } else if (tag[1] === 'mergeCell') {
          const ends = (attributes.get('ref') || '').split(':');
          if (ends.length !== 2) throw new Error('Invalid merged worksheet range.');
          const start = boundedCellReference(ends[0]), finish = boundedCellReference(ends[1]);
          if (finish.column < start.column || finish.row < start.row) throw new Error('Invalid merged worksheet range.');
          totalCells += (finish.column - start.column + 1) * (finish.row - start.row + 1);
        }
        if (totalCells > MAX_CELLS) throw new Error(`A workbook can contain at most ${MAX_CELLS.toLocaleString('en-US')} cells, including merged ranges. Export fewer rows or sheets.`);
      }
    }
    cursor = next;
  }
  if (cursor !== end || !names.has('xl/workbook.xml')) throw new Error('Invalid .xlsx workbook archive.');
}

function boundedCellReference(reference) {
  const match = /^([A-Z]+)(\d+)$/.exec(reference);
  if (!match) throw new Error('Invalid worksheet cell reference.');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (!row || column > MAX_COLUMNS || row > MAX_ROWS + 1) throw new Error(`Worksheets can contain at most ${MAX_COLUMNS} columns and ${MAX_ROWS.toLocaleString('en-US')} data rows.`);
  return { column, row };
}

function excelValue(cell, state) {
  if (!cell) return null;
  let value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    state.formulas++;
    if (value.result === undefined || value.result === null) { state.missingFormulaResults++; return null; }
    value = value.result;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
    if ('error' in value) { state.errors++; return null; }
    return String(value);
  }
  // A numeric Excel ID may use a display format such as 00000. Preserve it as text.
  // The output contains types only, so a tiny representative ID avoids allocating
  // potentially enormous strings for hostile/custom number formats.
  if (typeof value === 'number' && Number.isSafeInteger(value) && /^0{2,}$/.test(cell.numFmt || '')) return '00';
  return value;
}

async function importExcel(bytes, filename) {
  preflightXlsx(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes); }
  catch { throw new Error('Unable to read this .xlsx workbook. Upload a valid, unencrypted Excel workbook.'); }
  const tables = [], state = { formulas: 0, missingFormulaResults: 0, errors: 0 }, warnings = [], skippedSheets = [];
  let totalRows = 0;
  for (const worksheet of workbook.worksheets) {
    if (!worksheet.actualRowCount) { skippedSheets.push(worksheet.name); continue; }
    if (tables.length >= MAX_TABLES) throw new Error(`A workbook can contain at most ${MAX_TABLES} nonempty worksheets.`);
    if (worksheet.columnCount > MAX_COLUMNS) throw new Error(`A worksheet can contain at most ${MAX_COLUMNS} columns. Remove distant formatted or populated columns.`);
    if (worksheet.rowCount > MAX_ROWS + 1) throw new Error(`Worksheet row indexes must stay within ${MAX_ROWS + 1}. Remove distant formatted or populated rows.`);
    let headerValues = null, width = 0, rowCount = 0;
    const inferredTypes = Array(worksheet.columnCount).fill(null);
    worksheet.eachRow({ includeEmpty: false }, row => {
      const values = Array.from({ length: worksheet.columnCount }, (_, index) => excelValue(row.findCell(index + 1), state));
      const last = values.findLastIndex(value => value !== null && value !== undefined && value !== '');
      if (last < 0) return;
      width = Math.max(width, last + 1);
      if (!headerValues) { headerValues = values; return; }
      rowCount++;
      for (let index = 0; index <= last; index++) inferredTypes[index] = mergeType(inferredTypes[index], valueType(values[index]));
    });
    if (!headerValues) { skippedSheets.push(worksheet.name); continue; }
    // Include trailing fields present only in data; blank headers must be corrected.
    const headers = headersFor(headerValues.slice(0, width));
    totalRows += rowCount;
    if (totalRows > MAX_ROWS) throw new Error(`A workbook can contain at most ${MAX_ROWS.toLocaleString('en-US')} total data rows.`);
    tables.push({ name: worksheet.name, rowCount, columns: headers.map((name, index) => ({ name, dataType: inferredTypes[index] || 'string' })), measures: [] });
    if (worksheet.state && worksheet.state !== 'visible') warnings.push('Hidden worksheets are included in the imported model.');
    if (worksheet.model.merges?.length) warnings.push('The workbook contains merged cells. Verify that each table has a single, complete header row.');
  }
  if (!tables.length) throw new Error('The workbook contains no nonempty worksheets. Add a header row and data before importing.');
  if (skippedSheets.length) warnings.push(`${skippedSheets.length} empty worksheet(s) skipped: ${skippedSheets.join(', ')}.`);
  if (state.formulas) warnings.push('Excel formulas are not executed. Type inference uses their saved results when available.');
  if (state.missingFormulaResults) warnings.push(`${state.missingFormulaResults} formula cell(s) have no cached result and were treated as empty. Recalculate and save the workbook in Excel to include those values.`);
  if (state.errors) warnings.push(`${state.errors} Excel error cell(s) were treated as empty. Fix workbook errors for complete type inference.`);
  return inferredResult(tables, filename, 'xlsx', [...new Set(warnings)]);
}

export async function importFile(buffer, filename) {
  if (!(buffer instanceof Uint8Array)) throw new Error('File contents must be a byte buffer.');
  if (!buffer.length) throw new Error('The file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Files can be at most 2 MB. Export a smaller file and try again.');
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('A filename with a supported extension is required.');
  const extension = path.extname(filename).slice(1).toLowerCase(), bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (['csv', 'tsv', 'txt'].includes(extension)) return importDelimited(bytes, filename, extension);
  if (['json', 'bim'].includes(extension)) return importJson(bytes, filename, extension);
  if (['jsonl', 'ndjson'].includes(extension)) return importJsonLines(bytes, filename);
  if (extension === 'xml') return importXml(bytes, filename);
  if (extension === 'xlsx') return importExcel(bytes, filename);
  if (extension === 'xls') throw new Error('Legacy .xls files are unsupported. Save the workbook as .xlsx in Excel and try again.');
  if (['pbix', 'pbip', 'tmdl'].includes(extension)) throw new Error('Direct Power BI project/binary imports are unsupported. Export the semantic model as .bim or supported JSON metadata.');
  throw new Error('Unsupported file format. Use CSV, TSV, delimited TXT, XLSX, JSON, JSONL, NDJSON, XML, or BIM.');
}
