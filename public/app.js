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

function model() {
  if (new TextEncoder().encode($('model').value).length > 2_000_000) throw new Error('Metadata exceeds 2 MB. Use a smaller model export.');
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
async function importFile(file) {
  if (!file) return;
  const revision = ++importRevision;
  $('file').value = '';
  try {
    if (file.size > 2_000_000) throw new Error('File exceeds 2 MB. Use a smaller model export.');
    if (!/\.json$/i.test(file.name)) throw new Error('Choose a .json metadata file. PBIX files are not supported.');
    const text = await file.text();
    if (revision !== importRevision) return;
    $('model').value = text; sourceCaption = `Imported metadata · ${file.name}`; reset();
    if (validSource) status('JSON imported. Choose a tool to continue.');
    else status('Imported source needs attention. Check the message below the editor.');
  } catch (e) { if (revision === importRevision) { showError(e.message); status('Import failed. Existing metadata kept.'); } }
}
$('file').onchange = () => importFile($('file').files[0]);
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('drag-over'); });
$('dropzone').addEventListener('dragleave', event => { if (!$('dropzone').contains(event.relatedTarget)) $('dropzone').classList.remove('drag-over'); });
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); importFile(event.dataTransfer.files[0]); });
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
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' })), a = document.createElement('a');
  const name = String(model().name || 'model').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  a.href = url; a.download = `${name}-documentation.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Markdown export downloaded.');
};
$('sample').click();
