import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { readXlsx } from './xlsx-import.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { validateModel } from './lib.js';
import { getLimits } from './limits.js';

export const MAX_FILE_BYTES = getLimits().maxUploadBytes;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 512;
const MAX_TABLES = 128;
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
      const result = pick(measure, ['name', 'expression', 'description', 'dataType', 'formatString', 'isHidden', 'displayFolder']);
      return result;
    });
    const result = { ...pick(table, ['name', 'description', 'isHidden']), columns: cleanedColumns, measures: cleanedMeasures };
    for (const key of ['rowCount', 'sampledRowCount', 'headerRow']) {
      if (!Object.hasOwn(table, key)) continue;
      if (!Number.isSafeInteger(table[key]) || table[key] < (key === 'headerRow' ? 1 : 0)) throw new Error(`Table ${key} must be a ${key === 'headerRow' ? 'positive' : 'nonnegative'} safe integer.`);
      result[key] = table[key];
    }
    if (result.sampledRowCount !== undefined && (result.rowCount === undefined || result.sampledRowCount > result.rowCount)) throw new Error('Table sampledRowCount must not exceed rowCount.');
    if (Object.hasOwn(table, 'dataTypeInferred')) {
      if (typeof table.dataTypeInferred !== 'boolean') throw new Error('Table dataTypeInferred must be a boolean.');
      result.dataTypeInferred = table.dataTypeInferred;
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

async function importExcel(bytes, filename) {
  const { tables, warnings } = await readXlsx(bytes, { headersFor, valueType, mergeType, maxColumns: MAX_COLUMNS, maxTables: MAX_TABLES });
  return inferredResult(tables, filename, 'xlsx', warnings);
}

export async function importFile(buffer, filename) {
  if (!(buffer instanceof Uint8Array)) throw new Error('File contents must be a byte buffer.');
  if (!buffer.length) throw new Error('The file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Files can be at most ${MAX_FILE_BYTES / 1_000_000} MB. Export a smaller file and try again.`);
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
