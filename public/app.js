import { combineModels } from './import-model.js';
const $ = id => document.getElementById(id);
const example = {
  name: 'Retail Analytics',
  tables: [
    { name: 'Sales', description: 'One row per sales transaction.', columns: [{ name: 'Amount', dataType: 'decimal', description: 'Transaction revenue.' }, { name: 'Date', dataType: 'dateTime' }, { name: 'CustomerId', dataType: 'int64' }], measures: [{ name: 'Revenue', expression: "SUM('Sales'[Amount])" }] },
    { name: 'Calendar', columns: [{ name: 'Date', dataType: 'dateTime' }] },
    { name: 'Customers', columns: [{ name: 'CustomerId', dataType: 'int64' }] }
  ],
  relationships: [{ fromTable: 'Sales', fromColumn: 'Date', toTable: 'Calendar', toColumn: 'Date', cardinality: 'manyToOne', crossFilteringBehavior: 'oneDirection' }]
};
const busy = new Set();
let markdown = '', dax = '', modelRevision = 0, daxRevision = 0, importRevision = 0, validSource = false;
let sourceCaption = 'Sample metadata · editable';
let importController;
let limits = { maxUploadBytes: 10_000_000, maxModelBytes: 2_000_000, maxFiles: 10 };
let limitsLoaded = false;

function model() {
  if (new TextEncoder().encode($('model').value).length > limits.maxModelBytes) throw new Error(`Model metadata exceeds ${limits.maxModelBytes / 1_000_000} MB. Use a smaller model export.`);
  let data;
  try { data = JSON.parse($('model').value); } catch { throw new Error('Invalid JSON. Check commas, quotes, and brackets.'); }
  if (!data || !Array.isArray(data.tables) || !data.tables.length) throw new Error('Add a nonempty tables array. See the format guide.');
  const names = new Set();
  for (const table of data.tables) {
    if (!table || typeof table.name !== 'string' || !table.name.trim() || names.has(table.name)) throw new Error('Tables need unique, nonempty names.');
    names.add(table.name);
    for (const key of ['columns', 'measures']) {
      if (table[key] !== undefined && !Array.isArray(table[key])) throw new Error(`${table.name}.${key} must be an array.`);
      for (const item of table[key] || []) if (!item || typeof item.name !== 'string' || !item.name.trim()) throw new Error(`${key} need nonempty names.`);
    }
  }
  if (data.relationships !== undefined && !Array.isArray(data.relationships)) throw new Error('relationships must be an array.');
  for (const r of data.relationships || []) {
    if (!r || !names.has(r.fromTable) || !names.has(r.toTable)) throw new Error('Relationships must reference existing tables.');
    for (const side of ['from', 'to']) {
      if (!(data.tables.find(t => t.name === r[`${side}Table`]).columns || []).some(c => c.name === r[`${side}Column`])) throw new Error('Relationships must reference existing columns.');
    }
  }
  return data;
}
function status(message) { $('action-status').textContent = message; }
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function options(id, values, preferred) {
  const previous = $(id).value;
  $(id).replaceChildren(...values.map(value => { const option = document.createElement('option'); option.value = option.textContent = value; return option; }));
  if (values.includes(previous)) $(id).value = previous;
  else if (values.includes(preferred)) $(id).value = preferred;
}
function columns(tableId, columnId) {
  const values = model().tables.find(t => t.name === $(tableId).value)?.columns || [];
  const preferred = columnId === 'date-column' ? values.find(c => /date/i.test(c.dataType || c.name))?.name : values.find(c => /decimal|int|double|number|currency/i.test(c.dataType || ''))?.name;
  options(columnId, values.map(c => c.name), preferred);
}
function updateButtons() {
  for (const id of ['generate-docs', 'analyze']) $(id).disabled = !validSource || busy.has(id);
  const template = $('template').value;
  $('generate-dax').disabled = !validSource || busy.has('generate-dax') || !$('table').value || (template !== 'count' && !$('column').value) || (template === 'ytd' && (!$('date-table').value || !$('date-column').value));
  $('export-model').disabled = !validSource;
}
function templateFields() {
  const count = $('template').value === 'count', ytd = $('template').value === 'ytd';
  $('column-field').hidden = count; $('column').disabled = count || !validSource;
  for (const id of ['date-table', 'date-column']) { $(`${id}-field`).hidden = !ytd; $(id).disabled = !ytd || !validSource; }
  updateButtons();
}
function sync() {
  $('char-count').textContent = `${$('model').value.length.toLocaleString()} chars`;
  let message;
  try {
    const data = model(); validSource = true;
    $('model-name').textContent = data.name || 'Untitled model';
    $('model-caption').textContent = sourceCaption;
    $('table-count').textContent = data.tables.length;
    const columnCount = data.tables.reduce((n, t) => n + (t.columns || []).length, 0);
    $('column-count').textContent = `${columnCount} ${columnCount === 1 ? 'column' : 'columns'}`;
    $('measure-count').textContent = data.tables.reduce((n, t) => n + (t.measures || []).length, 0);
    $('relationship-count').textContent = (data.relationships || []).length;
    options('table', data.tables.map(t => t.name));
    const preferredDate = data.tables.find(t => /calendar|date/i.test(t.name)) || data.tables.find(t => (t.columns || []).some(c => /date/i.test(c.dataType || '')));
    options('date-table', data.tables.map(t => t.name), preferredDate?.name);
    columns('table', 'column'); columns('date-table', 'date-column');
    message = `Metadata loaded · ${data.tables.length} ${data.tables.length === 1 ? 'table' : 'tables'}`;
  } catch (error) {
    validSource = false; message = error.message;
    $('model-name').textContent = 'Model needs attention'; $('model-caption').textContent = 'Fix the source JSON to continue';
    for (const id of ['table-count', 'measure-count', 'relationship-count']) $(id).textContent = '—';
    $('column-count').textContent = '— columns';
    for (const id of ['table', 'column', 'date-table', 'date-column']) options(id, []);
  }
  $('source-status').textContent = message;
  $('source-status').classList.toggle('invalid', !validSource);
  document.querySelector('.editor-shell').classList.toggle('invalid', !validSource);
  $('model').setAttribute('aria-invalid', String(!validSource));
  $('table').disabled = !validSource;
  templateFields();
}
function resetDax() {
  daxRevision++; dax = '';
  $('dax-output').textContent = ''; $('dax-output').hidden = true; $('dax-empty').hidden = false;
  $('copy-dax').disabled = true; $('explanation').textContent = ''; $('explanation-card').hidden = true;
}
function reset() {
  modelRevision++; importRevision++; markdown = '';
  importController?.abort(); importController = undefined; setImportBusy(false);
  $('import-feedback').hidden = true; $('import-details').hidden = true; $('import-details-list').replaceChildren();
  $('download').disabled = true; $('copy-docs').disabled = true;
  $('docs-output').textContent = ''; $('docs-output').hidden = true; $('docs-empty').hidden = false;
  resetDax(); $('findings').replaceChildren(); $('findings').hidden = true; $('analysis-empty').hidden = false;
  $('analysis-summary').textContent = 'Awaiting analysis';
  showError(''); status('Ready when you are.'); sync();
}
async function run(path, input) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data.result;
}
function action(id, label, fn) {
  const button = $(id), labelNode = button.querySelector('span'), original = labelNode.textContent;
  button.onclick = async () => {
    const revision = modelRevision, dRevision = daxRevision;
    const current = () => revision === modelRevision && (id !== 'generate-dax' || dRevision === daxRevision);
    busy.add(id); button.setAttribute('aria-busy', 'true'); labelNode.textContent = label; updateButtons();
    showError(''); status(label);
    try { await fn(current); }
    catch (e) { if (current()) { showError(e.message); status('Action failed. Review the message above.'); } }
    finally { busy.delete(id); button.removeAttribute('aria-busy'); labelNode.textContent = original; updateButtons(); }
  };
}
function activateTab(button, focus = false) {
  document.querySelectorAll('.panel').forEach(panel => panel.hidden = panel.id !== button.dataset.panel);
  document.querySelectorAll('.tab').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  showError(''); if (focus) button.focus();
}
const tabs = [...document.querySelectorAll('.tab')];
for (const [index, button] of tabs.entries()) {
  button.onclick = () => activateTab(button);
  button.onkeydown = event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); activateTab(tabs[next], true); }
  };
}
$('help').onclick = () => {
  $('format-guide').open = !$('format-guide').open;
  if ($('format-guide').open) $('format-guide').scrollIntoView({ block: 'nearest' });
};
$('format-guide').addEventListener('toggle', () => $('help').setAttribute('aria-expanded', String($('format-guide').open)));
$('sample').onclick = () => { $('model').value = JSON.stringify(example, null, 2); sourceCaption = 'Sample metadata · editable'; reset(); status('Example model loaded. Choose a tool to begin.'); };
$('model').addEventListener('input', () => { sourceCaption = 'Edited metadata'; reset(); });
$('import').onclick = () => $('file').click();
function setImportBusy(value) {
  $('import').disabled = value || !limitsLoaded; $('import').setAttribute('aria-busy', String(value));
  $('import-label').textContent = value ? 'Importing…' : 'Import files';
  $('import-mode').disabled = value;
}
async function loadLimits() {
  try {
    const response = await fetch('/api/limits', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load upload settings.');
    const data = await response.json();
    if (!['maxUploadBytes', 'maxModelBytes', 'maxFiles'].every(key => Number.isSafeInteger(data[key]) && data[key] > 0)) throw new Error('Invalid upload settings.');
    limits = data; limitsLoaded = true;
    $('upload-limit-label').textContent = `${limits.maxUploadBytes / 1_000_000} MB PER FILE · UP TO ${limits.maxFiles} FILES`;
    $('guide-file-limits').textContent = `Up to ${limits.maxFiles} files · maximum ${limits.maxUploadBytes / 1_000_000} MB per file`;
    $('model-limit-label').textContent = `Generated model JSON is limited to ${limits.maxModelBytes / 1_000_000} MB.`;
    sync();
  } catch {
    $('upload-limit-label').textContent = 'UPLOAD SETTINGS UNAVAILABLE · RELOAD TO RETRY';
    $('guide-file-limits').textContent = 'Upload settings unavailable. Reload to retry.';
    importFeedback('Could not load upload settings. Reload the page to retry.', true);
  } finally { setImportBusy(Boolean(importController)); }
}
function importFeedback(message, failed = false) {
  $('import-feedback').textContent = message; $('import-feedback').hidden = false;
  $('import-feedback').classList.toggle('failed', failed);
}
async function importFiles(files) {
  if (!files.length) return;
  importController?.abort();
  const controller = new AbortController(); importController = controller;
  const revision = ++importRevision;
  $('file').value = '';
  setImportBusy(true); showError('');
  $('import-details').hidden = true; $('import-details-list').replaceChildren();
  try {
    await limitsReady;
    if (revision !== importRevision) return;
    if (!limitsLoaded) throw new Error('Could not load upload settings. Reload the page to retry.');
    if (files.length > limits.maxFiles) throw new Error(`Choose up to ${limits.maxFiles} files per import.`);
    const mode = $('import-mode').value;
    const existing = mode === 'append' ? model() : undefined;
    for (const file of files) {
      if (file.size > limits.maxUploadBytes) throw new Error(`${file.name}: uploaded file exceeds ${limits.maxUploadBytes / 1_000_000} MB.`);
      if (!/\.(csv|tsv|txt|xlsx|json|jsonl|ndjson|xml|bim)$/i.test(file.name)) throw new Error(`${file.name}: unsupported format. Use CSV, TSV, delimited TXT, XLSX, JSON, JSONL, XML, or BIM.`);
    }
    const results = [], notes = [], warnings = [];
    for (const [index, file] of files.entries()) {
      importFeedback(`Reading ${index + 1} of ${files.length}: ${file.name}`); status('Building model metadata…');
      const response = await fetch(`/api/import?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(`${file.name}: ${data.error || 'Import failed.'}`);
      if (revision !== importRevision) return;
      results.push(data.result.model);
      notes.push(`${file.name} → ${data.result.model.tables.map(t => {
        const details = [t.name];
        if (t.rowCount !== undefined) details.push(`${t.rowCount.toLocaleString()} data rows counted`);
        if (t.sampledRowCount !== undefined) details.push(`types inferred from ${t.sampledRowCount.toLocaleString()}${t.sampledRowCount < t.rowCount ? ' sampled' : ''} rows`);
        if (t.headerRow !== undefined) details.push(`headers on row ${t.headerRow.toLocaleString()}`);
        return details.join(' · ');
      }).join('; ')}`);
      warnings.push(...data.result.warnings.map(warning => `${file.name}: ${warning}`));
    }
    const combined = combineModels(results, { existing, mode });
    warnings.push(...combined.warnings);
    const text = JSON.stringify(combined.model, null, 2);
    if (new TextEncoder().encode(text).length > limits.maxModelBytes) throw new Error(`Combined model metadata exceeds ${limits.maxModelBytes / 1_000_000} MB. Import fewer tables.`);
    if (revision !== importRevision) return;
    $('model').value = text; sourceCaption = `Imported metadata · ${files.length} ${files.length === 1 ? 'file' : 'files'}`; reset();
    const added = results.reduce((n, result) => n + result.tables.length, 0);
    importFeedback(`${files.length} ${files.length === 1 ? 'file' : 'files'} imported · ${added} ${added === 1 ? 'table' : 'tables'} ${mode === 'append' ? 'added' : 'loaded'}`);
    $('import-details-title').textContent = `Import details · ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`;
    $('import-details').hidden = false; $('import-details').open = warnings.length > 0;
    for (const message of notes) { const li = document.createElement('li'); li.textContent = message; $('import-details-list').append(li); }
    for (const message of warnings) { const li = document.createElement('li'); li.className = 'import-warning'; li.textContent = `WARNING: ${message}`; $('import-details-list').append(li); }
    status('Model built. Review the metadata, then choose a tool.');
  } catch (e) {
    if (revision === importRevision) { importFeedback(`${e.message} Existing model kept.`, true); status('Import failed. Existing model kept.'); }
  } finally { if (importController === controller) { importController = undefined; setImportBusy(false); } }
}
$('file').onchange = () => importFiles([...$('file').files]);
$('import-mode').onchange = () => $('import-mode-hint').textContent = $('import-mode').value === 'append' ? 'Keeps existing tables and adds files in this batch.' : 'Replaces current metadata. Files in this batch are combined.';
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('drag-over'); });
$('dropzone').addEventListener('dragleave', event => { if (!$('dropzone').contains(event.relatedTarget)) $('dropzone').classList.remove('drag-over'); });
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); importFiles([...event.dataTransfer.files]); });
$('template').onchange = () => { resetDax(); templateFields(); status('Template updated. Generate a new measure.'); showError(''); };
$('table').onchange = () => { columns('table', 'column'); resetDax(); updateButtons(); };
$('date-table').onchange = () => { columns('date-table', 'date-column'); resetDax(); updateButtons(); };
for (const id of ['column', 'date-column']) $(id).onchange = () => { resetDax(); updateButtons(); };
action('generate-docs', 'Generating…', async current => {
  const result = await run('/api/docs', model()); if (!current()) return;
  markdown = result; $('docs-output').textContent = result; $('docs-output').hidden = false; $('docs-empty').hidden = true;
  $('download').disabled = false; $('copy-docs').disabled = false; status('Documentation generated. Ready to copy or export.');
});
action('generate-dax', 'Generating…', async current => {
  const result = await run('/api/dax', { template: $('template').value, table: $('table').value, column: $('column').value, dateTable: $('date-table').value, dateColumn: $('date-column').value });
  if (!current()) return;
  dax = result.expression; $('dax-output').textContent = dax; $('dax-output').hidden = false; $('dax-empty').hidden = true;
  $('explanation').textContent = result.explanation; $('explanation-card').hidden = false; $('copy-dax').disabled = false; status('Measure generated. Review the explanation before use.');
});
action('analyze', 'Analyzing…', async current => {
  const findings = await run('/api/analyze', model()); if (!current()) return;
  $('findings').replaceChildren(); $('findings').hidden = false; $('analysis-empty').hidden = true;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  $('analysis-summary').textContent = `${warnings} warnings · ${findings.length - warnings} info`;
  for (const f of findings) {
    const item = document.createElement('div'); item.className = `finding ${f.severity}`;
    const severity = document.createElement('span'); severity.className = 'severity'; severity.textContent = f.severity.toUpperCase();
    const content = document.createElement('div'), title = document.createElement('h3'), detail = document.createElement('p');
    title.textContent = f.title; detail.textContent = f.detail; content.append(title, detail); item.append(severity, content); $('findings').append(item);
  }
  if (!findings.length) {
    const item = document.createElement('div'); item.className = 'clear-review';
    const title = document.createElement('h3'), detail = document.createElement('p'); title.textContent = 'No findings from these checks.';
    detail.textContent = 'Validate model behavior in Power BI. Metadata checks do not cover all modeling or performance issues.';
    item.append(title, detail); $('findings').append(item);
  }
  status(`Review complete. ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} to consider.`);
});
async function copy(value, label) {
  try { await navigator.clipboard.writeText(value); showError(''); status(`${label} copied to clipboard.`); }
  catch { showError('Clipboard access is unavailable. Select and copy the output manually.'); }
}
$('copy-docs').onclick = () => copy(markdown, 'Documentation'); $('copy-dax').onclick = () => copy(dax, 'DAX measure');
function download(contents, extension, mime) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime })), a = document.createElement('a');
  const name = String(model().name || 'model').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  a.href = url; a.download = `${name}-${extension}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').onclick = () => {
  download(markdown, 'documentation.md', 'text/markdown');
  status('Markdown export downloaded.');
};
$('export-model').onclick = () => { download(JSON.stringify(model(), null, 2), 'model.json', 'application/json'); status('Model JSON exported. Data rows are not included.'); };
$('sample').click();
const limitsReady = loadLimits();
