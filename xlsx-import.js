import path from 'node:path';
import * as zlib from 'node:zlib';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';

const EXCEL_ROWS = 1_048_576;
const EXCEL_COLUMNS = 16_384;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_SHARED_STRINGS = 1_000_000;
const MAX_SHARED_CHARACTERS = 64_000_000;
const MAX_CELL_CHARACTERS = 32_767;
const MAX_XML_TOKEN_CHARACTERS = 1_000_000;

// Older supported Node 22 releases lack zlib.crc32. Verify ZIP checksums on
// those releases too, without loading complete decompressed entries.
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[index] = value >>> 0;
}
function checksum(chunk, previous) {
  if (zlib.crc32) return zlib.crc32(chunk, previous);
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of chunk) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function attribute(node, name) {
  for (const item of Object.values(node.attributes)) if (item.local === name) return item.value;
  return undefined;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function cellReference(reference) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference || '');
  if (!match) throw new Error('Invalid worksheet cell reference. Resave the workbook in Excel and try again.');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > EXCEL_COLUMNS || row > EXCEL_ROWS) throw new Error('Worksheet coordinates exceed Excel limits. Resave the workbook in Excel and try again.');
  return { row, column };
}

async function openArchive(buffer, maxExpandedBytes) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, archive) => error ? reject(error) : resolve(archive));
  }).catch(() => { throw new Error('Invalid .xlsx workbook. Upload a valid, unencrypted Excel .xlsx file.'); });
  const entries = new Map();
  try {
    await new Promise((resolve, reject) => {
      let expandedBytes = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.size >= MAX_ARCHIVE_ENTRIES) throw new Error('The workbook has too many archive entries. Export fewer embedded objects or sheets.');
          if (entries.has(entry.fileName)) throw new Error('Invalid .xlsx workbook archive with duplicate entries.');
          if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error('Encrypted or unsupported workbook archives cannot be imported. Save an unencrypted .xlsx workbook.');
          expandedBytes += entry.uncompressedSize;
          if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxExpandedBytes) throw new Error(`The workbook expands beyond the ${maxExpandedBytes / 1_000_000} MB processing limit. Export fewer rows, sheets, or embedded objects.`);
          entries.set(entry.fileName, entry);
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    if (!entries.has('xl/workbook.xml') || !entries.has('xl/_rels/workbook.xml.rels')) throw new Error('The archive does not contain a valid .xlsx workbook.');
    return { zip, entries, maxExpandedBytes, expandedReadBytes: 0 };
  } catch (error) { zip.close(); throw error; }
}

// XML is fed directly from an entry's decompression stream. The worksheet XML,
// row collection, and merged ranges are never materialized in memory.
async function parseXml(archive, entryName, handlers, expectedRoot) {
  const entry = archive.entries.get(entryName);
  if (!entry) throw new Error('The workbook is missing a required XML part. Resave it in Excel and try again.');
  const stream = await new Promise((resolve, reject) => archive.zip.openReadStream(entry, (error, result) => error ? reject(error) : resolve(result)));
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', () => { throw new Error('Invalid workbook XML. Resave the workbook in Excel and try again.'); });
  parser.on('doctype', () => { throw new Error('Workbook XML DTDs and custom entities are unsupported. Resave the workbook without a DTD.'); });
  let depth = 0;
  parser.on('opentag', node => {
    if (++depth > 128) throw new Error('The workbook XML has excessive nesting. Resave the workbook in Excel and try again.');
    if (depth === 1 && node.local !== expectedRoot) throw new Error('The workbook contains an invalid XML part. Resave it in Excel and try again.');
    handlers.opentag?.(node, depth);
  });
  parser.on('closetag', node => { handlers.closetag?.(node, depth); depth--; });
  for (const event of ['text', 'cdata']) if (handlers[event]) parser.on(event, handlers[event]);
  let decoder, expanded = 0, crc = 0, tokenLength = 0, lexicalState = 'text', prefix = '', ending = '', quote = '';
  const feed = text => {
    // Excel values are at most 32,767 characters. This more generous lexical
    // bound also keeps malformed, unterminated XML tokens from growing forever.
    for (const character of text) {
      if (++tokenLength > MAX_XML_TOKEN_CHARACTERS) throw new Error('The workbook contains an oversized XML value or token. Resave it in Excel and try again.');
      if (lexicalState === 'text') {
        if (character === '<') { lexicalState = 'prefix'; prefix = '<'; tokenLength = 1; }
      } else if (lexicalState === 'prefix') {
        prefix += character;
        if (prefix === '<?') { lexicalState = 'pi'; ending = '?'; }
        else if (prefix === '<!--') { lexicalState = 'comment'; ending = ''; }
        else if (prefix === '<![CDATA[') { lexicalState = 'cdata'; ending = ''; }
        else if (/^<!\s*(?:DOCTYPE|ENTITY)/i.test(prefix)) throw new Error('Workbook XML DTDs and custom entities are unsupported. Resave the workbook without a DTD.');
        else if (!prefix.startsWith('<!') && prefix.length >= 2) { lexicalState = 'tag'; quote = ''; }
        else if (prefix.length > 12) { lexicalState = 'tag'; quote = ''; }
      } else if (lexicalState === 'tag') {
        if (quote) { if (character === quote) quote = ''; }
        else if (character === '"' || character === "'") quote = character;
        else if (character === '>') { lexicalState = 'text'; tokenLength = 0; }
      } else {
        ending = (ending + character).slice(-3);
        const terminator = lexicalState === 'comment' ? '-->' : lexicalState === 'cdata' ? ']]>' : '?>';
        if (ending.endsWith(terminator)) { lexicalState = 'text'; tokenLength = 0; }
      }
    }
    parser.write(text);
  };
  try {
    for await (const chunk of stream) {
      expanded += chunk.length;
      archive.expandedReadBytes += chunk.length;
      if (expanded > entry.uncompressedSize || archive.expandedReadBytes > archive.maxExpandedBytes) throw new Error('Invalid or oversized workbook archive contents.');
      crc = checksum(chunk, crc);
      if (!decoder) {
        const encoding = chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le' : chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8';
        decoder = new TextDecoder(encoding, { fatal: true });
      }
      feed(decoder.decode(chunk, { stream: true }));
    }
    if (expanded !== entry.uncompressedSize || crc !== entry.crc32) throw new Error('The workbook archive checksum or size is invalid. Re-download or resave the file and try again.');
    if (decoder) feed(decoder.decode());
    parser.close();
  } catch (error) {
    stream.destroy();
    if (error instanceof TypeError) throw new Error('Invalid workbook XML encoding. Resave the workbook in Excel and try again.');
    throw error;
  }
}

async function workbookParts(archive) {
  const sheets = [], relationships = new Map();
  let inSheets = false;
  await parseXml(archive, 'xl/workbook.xml', {
    opentag(node, depth) {
      if (node.local === 'sheets' && depth === 2) inSheets = true;
      if (node.local !== 'sheet' || depth !== 3 || !inSheets) return;
      const name = attribute(node, 'name'), id = attribute(node, 'id');
      if (!name?.trim() || !id || sheets.some(sheet => sheet.name === name)) throw new Error('Workbook worksheets need unique, nonempty names and valid relationships.');
      sheets.push({ name, id, state: attribute(node, 'state') || 'visible' });
      if (sheets.length > 1024) throw new Error('The workbook contains too many worksheets.');
    },
    closetag(node, depth) { if (node.local === 'sheets' && depth === 2) inSheets = false; },
  }, 'workbook');
  await parseXml(archive, 'xl/_rels/workbook.xml.rels', {
    opentag(node, depth) {
      if (node.local !== 'Relationship' || depth !== 2) return;
      const id = attribute(node, 'Id'), target = attribute(node, 'Target'), type = attribute(node, 'Type');
      if (!id || !target || relationships.has(id)) throw new Error('Invalid workbook relationships. Resave the workbook in Excel and try again.');
      if (attribute(node, 'TargetMode') === 'External') { relationships.set(id, { external: true, type }); return; }
      const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
      if (!part.startsWith('xl/') || target.includes('\\')) throw new Error('Invalid workbook XML part path.');
      relationships.set(id, { part, type });
    },
  }, 'Relationships');
  let sharedStrings, styles;
  for (const relationship of relationships.values()) {
    if (relationship.type?.endsWith('/sharedStrings')) sharedStrings = relationship.part;
    if (relationship.type?.endsWith('/styles')) styles = relationship.part;
  }
  const worksheets = [], worksheetParts = new Set();
  for (const sheet of sheets) {
    const relationship = relationships.get(sheet.id);
    if (!relationship || relationship.external) throw new Error('Invalid or external worksheet relationship. Resave the workbook in Excel and try again.');
    // Chartsheets and other non-tabular sheet types supply no columns or rows.
    if (relationship.type?.endsWith('/worksheet')) {
      if (worksheetParts.has(relationship.part)) throw new Error('Invalid workbook: multiple worksheets refer to the same XML part. Resave it in Excel and try again.');
      worksheetParts.add(relationship.part);
      worksheets.push({ ...sheet, part: relationship.part });
    }
  }
  return { sheets: worksheets, sharedStrings, styles };
}

async function readSharedStrings(archive, entryName) {
  if (!entryName) return [];
  const strings = [];
  let value = '', inside = false, textDepth = 0, phoneticDepth = 0, characters = 0;
  await parseXml(archive, entryName, {
    opentag(node, depth) {
      if (node.local === 'si' && depth === 2) { inside = true; value = ''; }
      if (inside && node.local === 'rPh') phoneticDepth++;
      if (inside && node.local === 't' && !phoneticDepth) textDepth++;
    },
    text(text) {
      if (!inside || !textDepth || phoneticDepth) return;
      value += text;
      if (value.length > MAX_CELL_CHARACTERS) throw new Error('A workbook text cell exceeds Excel’s 32,767-character limit.');
    },
    cdata(text) {
      if (!inside || !textDepth || phoneticDepth) return;
      value += text;
      if (value.length > MAX_CELL_CHARACTERS) throw new Error('A workbook text cell exceeds Excel’s 32,767-character limit.');
    },
    closetag(node, depth) {
      if (node.local === 't' && textDepth && !phoneticDepth) textDepth--;
      if (node.local === 'rPh') phoneticDepth--;
      if (node.local !== 'si' || depth !== 2) return;
      characters += value.length;
      if (strings.length >= MAX_SHARED_STRINGS || characters > MAX_SHARED_CHARACTERS) throw new Error('The workbook has too many unique shared text values for safe processing. Export fewer sheets or split the workbook.');
      strings.push(value);
      inside = false;
    },
  }, 'sst');
  return strings;
}

function formatKind(id, format) {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return 'date';
  if (!format) return null;
  const cleaned = format.split(';')[0].replace(/"(?:[^"]|"")*"|\\.|_.|\*./g, '').replace(/\[([^\]]*)\]/g, (all, content) => /^[hms]+$/i.test(content) ? content : '');
  if (/^0{2,}$/.test(cleaned.trim())) return 'identifier';
  if (/^(?:general|@)$/i.test(cleaned.trim())) return null;
  return /[ymdhs]/i.test(cleaned) ? 'date' : null;
}

async function readStyles(archive, entryName) {
  if (!entryName) return [];
  const formats = new Map(), styles = [];
  let inCellStyles = false, inFormats = false;
  await parseXml(archive, entryName, {
    opentag(node, depth) {
      if (node.local === 'numFmts' && depth === 2) inFormats = true;
      if (node.local === 'numFmt' && depth === 3 && inFormats) {
        if (formats.size >= 65_536) throw new Error('The workbook has too many number formats.');
        formats.set(Number(attribute(node, 'numFmtId')), attribute(node, 'formatCode') || '');
      }
      if (node.local === 'cellXfs' && depth === 2) inCellStyles = true;
      if (node.local !== 'xf' || !inCellStyles || depth !== 3) return;
      if (styles.length >= 65_536) throw new Error('The workbook has too many cell styles.');
      const id = Number(attribute(node, 'numFmtId') || 0);
      styles.push(formatKind(id, formats.get(id)));
    },
    closetag(node, depth) {
      if (node.local === 'cellXfs' && depth === 2) inCellStyles = false;
      if (node.local === 'numFmts' && depth === 2) inFormats = false;
    },
  }, 'styleSheet');
  return styles;
}

function cellValue(cell, sharedStrings, styles, state) {
  if (cell.formula) {
    state.formulas++;
    if (cell.raw === '') { state.missingFormulaResults++; return null; }
  }
  if (cell.type === 'e') { state.errors++; return null; }
  if (cell.type === 'inlineStr') return cell.inline;
  if (cell.raw === '') return null;
  if (cell.type === 's') {
    if (!/^\d+$/.test(cell.raw) || !Object.hasOwn(sharedStrings, Number(cell.raw))) throw new Error('A worksheet refers to an invalid shared string. Resave the workbook in Excel and try again.');
    return sharedStrings[Number(cell.raw)];
  }
  if (cell.type === 'str' || cell.type === 'd') return cell.raw;
  if (cell.type === 'b') {
    if (cell.raw !== '0' && cell.raw !== '1') throw new Error('A worksheet contains an invalid boolean value.');
    return cell.raw === '1';
  }
  if (cell.type && cell.type !== 'n') throw new Error('The worksheet contains an unsupported cell value type. Resave it in Excel and try again.');
  const number = Number(cell.raw);
  if (!Number.isFinite(number)) throw new Error('A worksheet contains an invalid numeric value.');
  if (styles[cell.style] === 'date') return new Date(0);
  if (styles[cell.style] === 'identifier' && Number.isInteger(number)) return '00';
  // Preserve the source integer digits for inference when JavaScript cannot
  // represent the number exactly. No imported row values are exported.
  if (!Number.isSafeInteger(number) && /^[-+]?\d+$/.test(cell.raw)) return cell.raw;
  return number;
}

async function readWorksheet(archive, sheet, sharedStrings, styles, helpers, warnings, state) {
  const { headersFor, valueType, mergeType, maxColumns, sampleRows, headerRows } = helpers;
  const explicitHeaderRow = headerRows?.[sheet.name];
  if (explicitHeaderRow !== undefined) positiveInteger(explicitHeaderRow, null, 'Header row');
  let row = null, cell = null, rawDepth = 0, inlineDepth = 0, phoneticDepth = 0;
  let previousRow = 0, previousColumn = 0, rowCount = 0, sampledRows = 0, headers = null, types = [];
  let nonemptyRows = 0, skippedRows = 0, merged = false, headerRow = null;
  let singleHeader = null, singleHeaderRow = null, singleRowCount = 0, singleSampledRows = 0, singleType = null, singleWidthError = false;
  let sheetDataDepth = 0, mergeCellsDepth = 0;
  const nonempty = value => value !== null && value !== undefined && value !== '';
  const finishRow = () => {
    if (!row?.values.size) return;
    const width = Math.max(...row.values.keys());
    nonemptyRows++;
    if (width > maxColumns) throw new Error(`A worksheet can contain at most ${maxColumns} populated columns. Remove extra data columns or export a narrower table.`);
    if (!headers) {
      if (explicitHeaderRow !== undefined && row.index < explicitHeaderRow) { skippedRows++; return; }
      const values = Array.from({ length: width }, (_, index) => row.values.get(index + 1) ?? null);
      if (explicitHeaderRow !== undefined) {
        if (row.index !== explicitHeaderRow) throw new Error(`The selected header row is empty or missing in worksheet ${sheet.name}.`);
        headers = headersFor(values);
        headerRow = row.index;
        types = Array(headers.length).fill(null);
        return;
      }
      if (nonemptyRows <= 100 && width >= 2 && values.every(value => typeof value === 'string' && value.trim())) {
        headers = headersFor(values);
        headerRow = row.index;
        types = Array(headers.length).fill(null);
        skippedRows = nonemptyRows - 1;
        return;
      }
      if (width === 1 && !singleHeader && typeof values[0] === 'string' && values[0].trim()) {
        singleHeader = headersFor(values);
        singleHeaderRow = row.index;
      } else if (singleHeader) {
        singleRowCount++;
        if (width > 1) singleWidthError = true;
        if (singleSampledRows < sampleRows) {
          singleType = mergeType(singleType, valueType(values[0]));
          singleSampledRows++;
        }
      }
      return;
    }
    if (width > headers.length) throw new Error(`Worksheet ${sheet.name} has populated columns without headers. Choose a complete header row or export a flat table.`);
    rowCount++;
    if (sampledRows < sampleRows) {
      for (const [column, value] of row.values) types[column - 1] = mergeType(types[column - 1], valueType(value));
      sampledRows++;
    }
  };
  await parseXml(archive, sheet.part, {
    opentag(node, depth) {
      if (node.local === 'sheetData' && depth === 2) sheetDataDepth = depth;
      if (node.local === 'mergeCells' && depth === 2) mergeCellsDepth = depth;
      if (node.local === 'row' && sheetDataDepth && depth === sheetDataDepth + 1) {
        const reference = attribute(node, 'r');
        const index = reference === undefined ? previousRow + 1 : Number(reference);
        if (!Number.isInteger(index) || index < 1 || index > EXCEL_ROWS || index <= previousRow) throw new Error('Invalid or unordered worksheet row indexes. Resave the workbook in Excel and try again.');
        previousRow = index;
        previousColumn = 0;
        row = { index, values: new Map() };
      }
      if (node.local === 'c' && sheetDataDepth && depth === sheetDataDepth + 2) {
        if (!row || cell) throw new Error('Invalid worksheet cell structure.');
        const reference = attribute(node, 'r');
        const coordinate = reference ? cellReference(reference) : { row: row.index, column: previousColumn + 1 };
        if (coordinate.row !== row.index || coordinate.column <= previousColumn || coordinate.column > EXCEL_COLUMNS) throw new Error('Invalid or unordered worksheet cell references. Resave the workbook in Excel and try again.');
        previousColumn = coordinate.column;
        cell = { column: coordinate.column, type: attribute(node, 't'), style: Number(attribute(node, 's') || 0), raw: '', inline: '', formula: false };
      }
      if (cell && node.local === 'f') cell.formula = true;
      if (cell && node.local === 'v') rawDepth++;
      if (cell && node.local === 'rPh') phoneticDepth++;
      if (cell && node.local === 't' && !phoneticDepth) inlineDepth++;
      if (node.local === 'mergeCell' && mergeCellsDepth && depth === mergeCellsDepth + 1) {
        const ends = (attribute(node, 'ref') || '').split(':');
        if (ends.length < 1 || ends.length > 2) throw new Error('Invalid merged worksheet range.');
        const start = cellReference(ends[0]), end = cellReference(ends[1] || ends[0]);
        if (end.column < start.column || end.row < start.row) throw new Error('Invalid merged worksheet range.');
        merged = true;
      }
    },
    text(text) {
      if (!cell) return;
      if (rawDepth) cell.raw += text;
      if (inlineDepth && !phoneticDepth) cell.inline += text;
      if (cell.raw.length > MAX_CELL_CHARACTERS || cell.inline.length > MAX_CELL_CHARACTERS) throw new Error('A workbook text cell exceeds Excel’s 32,767-character limit.');
    },
    cdata(text) {
      if (!cell) return;
      if (rawDepth) cell.raw += text;
      if (inlineDepth && !phoneticDepth) cell.inline += text;
      if (cell.raw.length > MAX_CELL_CHARACTERS || cell.inline.length > MAX_CELL_CHARACTERS) throw new Error('A workbook text cell exceeds Excel’s 32,767-character limit.');
    },
    closetag(node, depth) {
      if (cell && node.local === 'v') rawDepth--;
      if (cell && node.local === 't' && inlineDepth && !phoneticDepth) inlineDepth--;
      if (cell && node.local === 'rPh') phoneticDepth--;
      if (node.local === 'c' && cell && depth === sheetDataDepth + 2) {
        const value = cellValue(cell, sharedStrings, styles, state);
        if (nonempty(value)) {
          if (cell.column > maxColumns) throw new Error(`A worksheet can contain at most ${maxColumns} populated columns. Remove extra data columns or export a narrower table.`);
          row.values.set(cell.column, value);
        }
        cell = null;
        rawDepth = inlineDepth = phoneticDepth = 0;
      }
      if (node.local === 'row' && sheetDataDepth && depth === sheetDataDepth + 1) { finishRow(); row = null; }
      if (node.local === 'sheetData' && depth === 2) sheetDataDepth = 0;
      if (node.local === 'mergeCells' && depth === 2) mergeCellsDepth = 0;
    },
  }, 'worksheet');
  if (!nonemptyRows) return null;
  if (!headers && explicitHeaderRow !== undefined) throw new Error(`The selected header row is empty or missing in worksheet ${sheet.name}.`);
  if (!headers && singleHeader && !singleWidthError) {
    headers = singleHeader;
    headerRow = singleHeaderRow;
    types = [singleType];
    rowCount = singleRowCount;
    sampledRows = singleSampledRows;
    skippedRows = nonemptyRows - singleRowCount - 1;
  }
  if (!headers) throw new Error(`No complete text header row was found in the first 100 nonempty rows of worksheet ${sheet.name}. Export a flat table with unique, nonempty column headers.`);
  if (rowCount > sampledRows) warnings.push(`Worksheet ${sheet.name}: column types were inferred from the first ${sampledRows.toLocaleString('en-US')} nonempty data rows; all ${rowCount.toLocaleString('en-US')} data rows were counted. Review types for values outside this sample.`);
  if (skippedRows) warnings.push(`Worksheet ${sheet.name}: skipped ${skippedRows} title or preamble row(s) before the detected header. Verify the selected column names.`);
  if (merged) warnings.push(`Worksheet ${sheet.name}: merged ranges were not expanded or counted as data. Only populated cells were read; verify that the detected header describes one flat table.`);
  if (sheet.state !== 'visible') warnings.push('Hidden worksheets are included in the imported model.');
  return { name: sheet.name, rowCount, sampledRowCount: sampledRows, dataTypeInferred: true, headerRow, columns: headers.map((name, index) => ({ name, dataType: types[index] || 'string' })), measures: [] };
}

/** Stream XLSX metadata inference without storing imported rows or expanding merges. */
export async function readXlsx(buffer, options = {}) {
  const helpers = {
    ...options,
    sampleRows: positiveInteger(options.sampleRows, 5000, 'XLSX sample rows'),
    maxColumns: positiveInteger(options.maxColumns, 512, 'Maximum columns'),
    maxTables: positiveInteger(options.maxTables, 128, 'Maximum tables'),
  };
  for (const name of ['headersFor', 'valueType', 'mergeType']) if (typeof helpers[name] !== 'function') throw new Error(`XLSX inference requires the ${name} helper.`);
  const maxExpandedBytes = positiveInteger(options.maxExpandedBytes, 200_000_000, 'Maximum expanded workbook bytes');
  const archive = await openArchive(buffer, maxExpandedBytes);
  const warnings = [], tables = [], skipped = [];
  const state = { formulas: 0, missingFormulaResults: 0, errors: 0 };
  try {
    const parts = await workbookParts(archive);
    const sharedStrings = await readSharedStrings(archive, parts.sharedStrings);
    const styles = await readStyles(archive, parts.styles);
    for (const sheet of parts.sheets) {
      const table = await readWorksheet(archive, sheet, sharedStrings, styles, helpers, warnings, state);
      if (!table) { skipped.push(sheet.name); continue; }
      if (tables.length >= helpers.maxTables) throw new Error(`A workbook can contain at most ${helpers.maxTables} nonempty worksheets.`);
      tables.push(table);
    }
    if (!tables.length) throw new Error('The workbook contains no nonempty worksheets. Add a header row and data before importing.');
    if (skipped.length) warnings.push(`${skipped.length} empty worksheet(s) skipped: ${skipped.join(', ')}.`);
    if (state.formulas) warnings.push('Excel formulas are not executed. Type inference uses their saved results when available.');
    if (state.missingFormulaResults) warnings.push(`${state.missingFormulaResults} formula cell(s) have no cached result and were treated as empty. Recalculate and save the workbook in Excel to include those values.`);
    if (state.errors) warnings.push(`${state.errors} Excel error cell(s) were treated as empty. Fix workbook errors for complete type inference.`);
    return { tables, warnings: [...new Set(warnings)] };
  } finally { archive.zip.close(); }
}
