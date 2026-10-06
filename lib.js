export function validateModel(model) {
  if (!model || !Array.isArray(model.tables) || !model.tables.length) throw new Error('Model must contain a nonempty tables array.');
  const names = new Set();
  for (const table of model.tables) {
    if (!table || typeof table.name !== 'string' || !table.name.trim() || names.has(table.name)) throw new Error('Tables need unique, nonempty names.');
    names.add(table.name);
    for (const key of ['columns', 'measures']) {
      if (table[key] !== undefined && !Array.isArray(table[key])) throw new Error(`${table.name}.${key} must be an array.`);
      for (const item of table[key] || []) if (!item || typeof item.name !== 'string' || !item.name.trim()) throw new Error(`${key} need nonempty names.`);
    }
  }
  if (model.relationships !== undefined && !Array.isArray(model.relationships)) throw new Error('relationships must be an array.');
  for (const r of model.relationships || []) {
    if (!r || !names.has(r.fromTable) || !names.has(r.toTable)) throw new Error('Relationships must reference existing tables.');
    for (const side of ['from', 'to']) {
      if (!(model.tables.find(t => t.name === r[`${side}Table`]).columns || []).some(c => c.name === r[`${side}Column`])) throw new Error('Relationships must reference existing columns.');
    }
  }
  return model;
}
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
export function documentModel(input) {
  const model = validateModel(input);
  const lines = [`# ${cell(model.name || 'Power BI model')}`, '', '## Tables'];
  for (const t of model.tables) {
    lines.push('', `### ${cell(t.name)}`, '', cell(t.description || ''));
    if (t.dataTypeInferred && Number.isSafeInteger(t.sampledRowCount) && Number.isSafeInteger(t.rowCount)) {
      lines.push('', `Column types inferred from ${t.sampledRowCount.toLocaleString('en-US')} of ${t.rowCount.toLocaleString('en-US')} data rows.${t.sampledRowCount < t.rowCount ? ' Later rows were not used for type inference; review mixed types.' : ''}`);
    }
    lines.push('', '| Column | Type | Description |', '| --- | --- | --- |');
    for (const c of t.columns || []) lines.push(`| ${cell(c.name)} | ${cell(c.dataType || 'Unspecified')} | ${cell(c.description)} |`);
    for (const m of t.measures || []) lines.push('', `#### Measure: ${cell(m.name)}`, '', cell(m.description), '', '```dax', String(m.expression || '').replaceAll('```', ''), '```');
  }
  lines.push('', '## Relationships', '', '| From | To | Cardinality | Filter direction |', '| --- | --- | --- | --- |');
  for (const r of model.relationships || []) lines.push(`| ${cell(r.fromTable)}.${cell(r.fromColumn)} | ${cell(r.toTable)}.${cell(r.toColumn)} | ${cell(r.cardinality || 'Unspecified')} | ${cell(r.crossFilteringBehavior || 'Unspecified')} |`);
  return lines.join('\n');
}
export function analyzeModel(input) {
  const model = validateModel(input), findings = [];
  for (const t of model.tables) {
    if (!t.description) findings.push({ severity: 'info', title: `${t.name}: missing description`, detail: 'Describe the table purpose and grain.' });
    if (model.tables.length > 1 && !(model.relationships || []).some(r => r.fromTable === t.name || r.toTable === t.name)) findings.push({ severity: 'warning', title: `${t.name}: disconnected table`, detail: 'Check whether this is an intentional parameter or disconnected table.' });
    for (const m of t.measures || []) if (!m.expression) findings.push({ severity: 'warning', title: `${m.name}: missing expression`, detail: 'Include the DAX expression in the metadata export.' });
  }
  for (const r of model.relationships || []) {
    if (/manytomany|many-to-many/i.test(r.cardinality || '')) findings.push({ severity: 'warning', title: 'Many-to-many relationship', detail: `${r.fromTable} → ${r.toTable}: review grain and consider a bridge table.` });
    if (/both|bidirectional/i.test(r.crossFilteringBehavior || '')) findings.push({ severity: 'warning', title: 'Bidirectional filtering', detail: `${r.fromTable} → ${r.toTable}: check for ambiguous filter paths.` });
  }
  return findings;
}
export function generateDax({ template, table, column, dateTable, dateColumn }) {
  if (typeof table !== 'string' || !table.trim()) throw new Error('Choose a table.');
  const t = `'${table.replaceAll("'", "''")}'`;
  const reference = (name) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Choose the required column.');
    return `[${name.replaceAll(']', ']]')}]`;
  };
  if (template === 'count') return { expression: `Row Count = COUNTROWS(${t})`, explanation: 'Counts rows visible in the current filter context.' };
  const c = reference(column);
  if (template === 'sum') return { expression: `Total = SUM(${t}${c})`, explanation: 'Sums a numeric column in the current filter context.' };
  if (template === 'distinct') return { expression: `Distinct Count = DISTINCTCOUNT(${t}${c})`, explanation: 'Counts distinct values, including BLANK, in the current filter context.' };
  if (template === 'ytd') {
    if (typeof dateTable !== 'string' || !dateTable.trim()) throw new Error('Choose a date table.');
    return { expression: `Total YTD = TOTALYTD(SUM(${t}${c}), '${dateTable.replaceAll("'", "''")}'${reference(dateColumn)})`, explanation: 'Calculates a calendar year-to-date total. Requires a suitable date table with a unique, contiguous date column and an active relationship to the fact table.' };
  }
  throw new Error('Unknown DAX template.');
}
