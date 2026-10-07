import { analyzeModel, validateModel } from './lib.js';

const numeric = /^(?:int64|decimal|double|currency|number|integer|float)$/i;

/** Explainable metadata checks; this score does not measure query performance. */
export function inspectModel(input) {
  const model = validateModel(input);
  const findings = analyzeModel(model).map((finding, index) => ({
    ...finding, id: `base-${index}`, category: /description/.test(finding.title) ? 'Documentation' : /expression/.test(finding.title) ? 'DAX' : 'Relationships',
  }));
  const add = (severity, category, table, title, detail, recommendation) => findings.push({ id: `check-${findings.length}`, severity, category, table, title, detail, recommendation });
  let columns = 0, measures = 0, describedColumns = 0, describedMeasures = 0;
  for (const table of model.tables) {
    columns += (table.columns || []).length;
    measures += (table.measures || []).length;
    describedColumns += (table.columns || []).filter(column => column.description?.trim()).length;
    describedMeasures += (table.measures || []).filter(measure => measure.description?.trim()).length;
    const seen = new Set();
    for (const column of table.columns || []) {
      const key = column.name.toLowerCase();
      if (seen.has(key)) add('critical', 'Data types', table.name, `${table.name}: duplicate column name`, `${column.name} collides with another column when case is ignored.`, 'Use distinct column names in the semantic model.');
      seen.add(key);
    }
    const unspecified = (table.columns || []).filter(column => !column.dataType);
    if (unspecified.length) add('warning', 'Data types', table.name, `${table.name}: unspecified data types`, `${unspecified.length} column(s) have no declared data type.`, 'Declare types before choosing aggregations or date calculations.');
    const undocumented = (table.columns || []).filter(column => !column.description?.trim());
    if (undocumented.length) add('info', 'Documentation', table.name, `${table.name}: column definitions missing`, `${undocumented.length} of ${(table.columns || []).length} columns have no description.`, 'Explain business meaning, units, grain, and identifier semantics.');
    const numericKeys = (table.columns || []).filter(column => numeric.test(column.dataType || '') && (column.isKey || /(?:id|key|code)$/i.test(column.name)));
    if (numericKeys.length) add('info', 'Data types', table.name, `${table.name}: numeric identifiers`, `${numericKeys.map(column => column.name).join(', ')} look like identifiers.`, 'Use Do not summarize for identifiers; preserve leading zeros where required.');
    if (table.dataTypeInferred && Number.isSafeInteger(table.sampledRowCount) && table.sampledRowCount < table.rowCount) add('warning', 'Data types', table.name, `${table.name}: sampled type inference`, `${table.sampledRowCount.toLocaleString('en-US')} of ${table.rowCount.toLocaleString('en-US')} data rows informed column types.`, 'Review values outside the sample before accepting inferred types.');
    const measureNames = new Set();
    for (const measure of table.measures || []) {
      const key = measure.name.toLowerCase();
      if (measureNames.has(key)) add('critical', 'DAX', table.name, `${table.name}: duplicate measure name`, `${measure.name} appears more than once.`, 'Give every measure a unique name.');
      measureNames.add(key);
      const expression = String(measure.expression || '');
      if (/\b(?:TOTALYTD|SAMEPERIODLASTYEAR|DATEADD|DATESYTD)\s*\(/i.test(expression) && !model.tables.some(t => (t.columns || []).some(column => /^(datetime|date)$/i.test(column.dataType || '')))) add('warning', 'DAX', table.name, `${measure.name}: time intelligence needs date metadata`, 'The expression uses time intelligence but no declared date column appears in this model.', 'Verify a marked date table with a unique, contiguous date column and an active relationship.');
      if (/\b(?:SUMX|AVERAGEX|FILTER)\s*\(/i.test(expression)) add('info', 'DAX', table.name, `${measure.name}: iterator or filter review`, 'An iterator or FILTER expression deserves a context and performance review.', 'Check the iterated table size and filter context in Power BI; this finding is not a measured performance issue.');
    }
  }
  const relationships = model.relationships || [];
  const links = new Set();
  for (const relation of relationships) {
    const key = [relation.fromTable, relation.fromColumn, relation.toTable, relation.toColumn].join('\0');
    if (links.has(key)) add('warning', 'Relationships', relation.fromTable, 'Repeated relationship endpoints', `${relation.fromTable}.${relation.fromColumn} → ${relation.toTable}.${relation.toColumn} appears more than once.`, 'Check that each relationship is intentional and only the appropriate path is active.');
    links.add(key);
    const from = model.tables.find(t => t.name === relation.fromTable)?.columns?.find(c => c.name === relation.fromColumn);
    const to = model.tables.find(t => t.name === relation.toTable)?.columns?.find(c => c.name === relation.toColumn);
    if (from?.dataType && to?.dataType && from.dataType.toLowerCase() !== to.dataType.toLowerCase()) add('warning', 'Relationships', relation.fromTable, 'Relationship type mismatch', `${relation.fromTable}.${relation.fromColumn} (${from.dataType}) connects to ${relation.toTable}.${relation.toColumn} (${to.dataType}).`, 'Align key types on both ends before creating the relationship in Power BI.');
    if (relation.isActive === false) add('info', 'Relationships', relation.fromTable, 'Inactive relationship', `${relation.fromTable}.${relation.fromColumn} → ${relation.toTable}.${relation.toColumn} is inactive.`, 'Confirm measures intentionally activate it with USERELATIONSHIP where needed.');
  }
  const counts = { critical: 0, warning: 0, info: 0, total: findings.length };
  for (const finding of findings) counts[finding.severity]++;
  const score = Math.max(0, 100 - counts.critical * 20 - counts.warning * 8 - counts.info * 2);
  return {
    score, counts, findings, relationships,
    stats: { tables: model.tables.length, columns, measures, relationships: relationships.length, describedColumns, describedMeasures },
    scoreExplanation: 'Metadata checklist score: starts at 100; each critical finding deducts 20, warning 8, and informational finding 2. It does not evaluate data accuracy or query performance.',
  };
}

/** Lightweight DAX guidance; not a parser, compiler, or formula execution engine. */
export function reviewDax({ expression, model }) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('Paste a DAX expression to review.');
  if (expression.length > 16_000) throw new Error('DAX expressions can contain at most 16,000 characters.');
  if (model !== undefined) validateModel(model);
  const findings = [];
  const add = (title, detail) => findings.push({ severity: 'info', title, detail });
  if (/\bDIVIDE\s*\(/i.test(expression)) add('Division handling', 'DIVIDE handles a zero or blank denominator. Verify its alternate result matches the business definition.');
  else if (expression.includes('/')) add('Division handling', 'Consider DIVIDE(numerator, denominator) when the denominator can be zero or blank.');
  if (/\bCALCULATE\s*\(/i.test(expression)) add('Filter context', 'CALCULATE changes filter context and can perform context transition. Verify every filter argument and the intended grain.');
  if (/\bALL\s*\(|\bREMOVEFILTERS\s*\(/i.test(expression)) add('Filters removed', 'Identify exactly which filters this expression removes and test totals and slicer interactions.');
  if (/\b(?:SUMX|AVERAGEX|FILTER)\s*\(/i.test(expression)) add('Iteration', 'Test row context and the iterated table size. An iterator is not inherently a performance problem.');
  if (/\b(?:TOTALYTD|DATEADD|SAMEPERIODLASTYEAR|DATESINPERIOD)\s*\(/i.test(expression)) add('Date prerequisites', 'Time intelligence needs a suitable unique, contiguous date column and an appropriate active relationship.');
  return { findings, notice: 'Rule-based guidance only. No DAX syntax compilation, evaluation, or performance measurement was performed. Validate in Power BI Desktop.' };
}
