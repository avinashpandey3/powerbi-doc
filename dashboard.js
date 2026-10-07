import { validateModel } from './lib.js';

const STYLES = {
  midnight: { name: 'Power BI Doctor · Midnight', dataColors: ['#31D3BE', '#6BA8FF', '#AD92FF', '#F5BC62', '#E988AA', '#82C8AF'], background: '#101923', foreground: '#E9F1F8', tableAccent: '#31D3BE' },
  violet: { name: 'Power BI Doctor · Violet', dataColors: ['#AE95FF', '#53D8CB', '#79B5FF', '#E99DBE', '#F2C76E', '#90CBA1'], background: '#191427', foreground: '#F1ECFB', tableAccent: '#AE95FF' },
  light: { name: 'Power BI Doctor · Light', dataColors: ['#087F8C', '#5267C9', '#9870C3', '#B76122', '#B64069', '#46865D'], background: '#F7F9FC', foreground: '#192B3E', tableAccent: '#087F8C' },
  slate: { name: 'Power BI Doctor · Slate', dataColors: ['#7CB8D9', '#87C9AE', '#AEA1D2', '#D6B782', '#CD98AF', '#8EA8C6'], background: '#202C3B', foreground: '#EDF2F7', tableAccent: '#7CB8D9' },
};
const NUMERIC_TYPES = new Set(['int', 'integer', 'int16', 'int32', 'int64', 'long', 'double', 'decimal', 'currency', 'float', 'single', 'number', 'numeric']);
const DATE_TYPES = new Set(['date', 'datetime', 'datetime64', 'datetimezone']);
const TEXT_TYPES = new Set(['string', 'text', 'boolean', 'bool']);
const normalizedType = field => String(field.dataType || '').toLowerCase();
const numeric = field => NUMERIC_TYPES.has(normalizedType(field));
const date = field => DATE_TYPES.has(normalizedType(field));
const visible = item => item.isHidden !== true;
const quotedTable = name => `'${name.replaceAll("'", "''")}'`;
const quotedField = name => `[${name.replaceAll(']', ']]')}]`;
const fieldReference = (table, column) => `${quotedTable(table)}${quotedField(column)}`;
const md = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function textInput(value, fallback, maximum, name) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${name} can contain at most ${maximum} characters.`);
  return result || fallback;
}

function briefScore(name, brief) {
  const words = String(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3);
  return words.reduce((score, word) => score + (brief.includes(word) ? 1 : 0), 0);
}

function identifier(column, table, model) {
  const label = column.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (column.isKey === true || /(?:^|[ _.-])(?:id|key|code|zip|postcode|fips|year|month|quarter|sa[1-4])(?:$|[ _.-])/.test(label)) return true;
  if ((table.columns || []).some(field => field.sortByColumn === column.name)) return true;
  return (model.relationships || []).some(relationship =>
    (relationship.fromTable === table.name && relationship.fromColumn === column.name) ||
    (relationship.toTable === table.name && relationship.toColumn === column.name));
}

function measureKind(measure) {
  if (!visible(measure) || typeof measure.expression !== 'string' || !measure.expression.trim()) return null;
  const type = normalizedType(measure);
  if (type) return NUMERIC_TYPES.has(type) ? 'explicit' : null;
  if (/^(?:FORMAT|CONCATENATE|CONCATENATEX|LEFT|RIGHT|MID|LOWER|UPPER|TRIM|SELECTEDVALUE|DATE|DATEVALUE|TIME|NOW|TODAY)\s*\(/i.test(measure.expression.trim())) return null;
  if (typeof measure.formatString === 'string' && /[0#]/.test(measure.formatString.replace(/"[^"]*"|\\./g, ''))) return 'inferred';
  // Only familiar numeric-returning functions qualify without a declared type.
  // A text-returning FORMAT/SELECTEDVALUE measure is never used as a metric.
  const expression = measure.expression.trim();
  if (/^(?:COUNTROWS|COUNT|COUNTA|COUNTX|COUNTAX|DISTINCTCOUNT|DISTINCTCOUNTNOBLANK|SUM|SUMX|AVERAGE|AVERAGEX|DIVIDE|STDEV\.S|STDEV\.P|VAR\.S|VAR\.P)\s*\(/i.test(expression)) return 'inferred';
  if (/^[+-]?\d+(?:\.\d+)?$/.test(expression)) return 'inferred';
  return null;
}

function metricsFor(table, model, brief, warnings) {
  const measures = (table.measures || []).map(measure => ({ measure, kind: measureKind(measure) })).filter(item => item.kind)
    .sort((left, right) => briefScore(right.measure.name, brief) - briefScore(left.measure.name, brief));
  const metrics = measures.slice(0, 3).map(({ measure, kind }) => {
    if (kind === 'inferred') warnings.push(`${table.name}.${measure.name}: numeric suitability is inferred from the saved measure expression or format; verify its result type in Power BI.`);
    return { title: measure.name, table: table.name, measure: { table: table.name, name: measure.name }, rationale: 'Uses an existing measure and preserves its calculation and filter-context semantics.' };
  });
  const columns = (metrics.length ? [] : table.columns || []).filter(column => visible(column) && numeric(column) && !identifier(column, table, model))
    .sort((left, right) => briefScore(right.name, brief) - briefScore(left.name, brief));
  for (const column of columns) {
    if (metrics.length >= 3) break;
    const aggregation = /rate|ratio|percent|average|mean|age|temperature|index|score/i.test(column.name) ? 'average' : 'sum';
    const title = `${aggregation === 'average' ? 'Average' : 'Total'} ${column.name}`;
    const definitionName = `Dashboard ${title}`.replace(/[\[\]=\r\n]/g, ' ').slice(0, 120);
    metrics.push({ title, table: table.name, value: { table: table.name, column: column.name }, aggregation,
      suggestedDax: `${definitionName} = ${aggregation === 'average' ? 'AVERAGE' : 'SUM'}(${fieldReference(table.name, column.name)})`,
      rationale: `Uses the numeric ${column.name} column. ${aggregation === 'average' ? 'AVERAGE is a starting point for a rate or score; a weighted measure may be necessary.' : 'SUM assumes additive values at this table’s grain.'}` });
    warnings.push(`${table.name}.${column.name}: review the proposed ${aggregation.toUpperCase()} aggregation against the source table’s grain${aggregation === 'average' ? '; rates and averages may need weighting' : ''}.`);
  }
  if (!metrics.length) {
    metrics.push({ title: `${table.name} row count`, table: table.name, aggregation: 'countRows',
      suggestedDax: `Dashboard Row Count = COUNTROWS(${quotedTable(table.name)})`,
      rationale: 'Counts rows in the current filter context without summing identifiers or inventing a business metric.' });
    warnings.push(`${table.name}: no confirmed numeric measure or suitable numeric value column was found. Row count is a starting metric; confirm what one row represents.`);
  }
  const unusedMeasures = (table.measures || []).filter(measure => visible(measure) && !measureKind(measure));
  if (unusedMeasures.length) warnings.push(`${table.name}: ${unusedMeasures.length} measure(s) were not selected because a saved expression and numeric result type could not be established. Review those measures before using them in numeric visuals.`);
  return metrics;
}

function linkedDimensions(table, tables, model, warnings) {
  const linked = [];
  for (const relationship of model.relationships || []) {
    if (relationship.isActive === false) continue;
    const cardinality = String(relationship.cardinality || '').replace(/[-_\s]/g, '').toLowerCase();
    const from = String(relationship.fromCardinality || '').toLowerCase();
    const to = String(relationship.toCardinality || '').toLowerCase();
    const direction = String(relationship.crossFilteringBehavior || '').toLowerCase();
    if (/both|bidirectional/.test(direction) || cardinality === 'manytomany' || (from === 'many' && to === 'many')) {
      if (relationship.fromTable === table.name || relationship.toTable === table.name) warnings.push(`${table.name}: a many-to-many or bidirectional relationship needs review. Its related fields were excluded from automatic chart bindings.`);
      continue;
    }
    let dimension;
    if (relationship.fromTable === table.name && (cardinality === 'manytoone' || (from === 'many' && to === 'one'))) dimension = tables.find(candidate => candidate.name === relationship.toTable);
    else if (relationship.toTable === table.name && (cardinality === 'onetomany' || (from === 'one' && to === 'many'))) dimension = tables.find(candidate => candidate.name === relationship.fromTable);
    if (dimension && !linked.some(candidate => candidate.name === dimension.name)) linked.push(dimension);
  }
  return linked;
}

function fieldsFor(table, tables, model, brief, warnings) {
  const related = linkedDimensions(table, tables, model, warnings);
  const sources = [table, ...related];
  const categories = [], dates = [];
  for (const source of sources) {
    for (const column of source.columns || []) {
      if (!visible(column)) continue;
      const binding = { table: source.name, column: column.name };
      if (date(column)) dates.push(binding);
      else if (TEXT_TYPES.has(normalizedType(column)) && !identifier(column, source, model)) categories.push(binding);
    }
  }
  categories.sort((left, right) => briefScore(right.column, brief) - briefScore(left.column, brief));
  dates.sort((left, right) => briefScore(right.column, brief) - briefScore(left.column, brief));
  if (!dates.length && tables.some(candidate => candidate !== table && (candidate.columns || []).some(column => visible(column) && date(column)))) {
    warnings.push(`${table.name}: date fields in other tables were not used because an active, suitable one-to-many relationship was not established.`);
  }
  return { categories, dates };
}

// Power BI supplies Deneb's dataset when the listed fields are added to its
// Values well. Existing measures already evaluate in Power BI filter context;
// Vega-Lite must not aggregate them again.
function denebFor(visual, warnings, theme) {
  if (!visual.category || !['bar', 'line', 'donut'].includes(visual.type)) return {};
  const valueName = visual.measure?.name || visual.value?.column;
  if (!valueName) {
    warnings.push(`${visual.title}: a Deneb specification was not generated for the row-count placeholder. Create its suggested COUNTROWS measure and bind that actual measure before configuring Deneb.`);
    return {};
  }
  if (valueName === visual.category.column) {
    warnings.push(`${visual.title}: category and metric share a display name. Rename the field in the Deneb Values well and adapt the specification before using it.`);
    return {};
  }
  const vegaField = name => name.replace(/[\\.\[\]]/g, '\\$&');
  const category = { field: vegaField(visual.category.column), type: visual.type === 'line' ? 'temporal' : 'nominal', title: visual.category.column };
  const value = { field: vegaField(valueName), type: 'quantitative', title: visual.title };
  if (visual.value) value.aggregate = visual.aggregation === 'average' ? 'mean' : 'sum';
  let encoding, mark;
  if (visual.type === 'line') {
    mark = { type: 'line', point: true, tooltip: true };
    encoding = { x: category, y: value };
  } else if (visual.type === 'donut') {
    mark = { type: 'arc', innerRadius: 65, tooltip: true };
    encoding = { theta: value, color: category };
  } else {
    mark = { type: 'bar', tooltip: true };
    encoding = { y: category, x: value };
  }
  if (visual.type === 'donut') encoding.color.scale = { range: [...theme.dataColors] };
  else mark.color = theme.dataColors[0];
  const denebFields = [{ ...visual.category, role: 'category' }, visual.measure ? { table: visual.measure.table, measure: visual.measure.name, role: 'value' } : { ...visual.value, role: 'value' }];
  if (visual.value) warnings.push(`${visual.title}: the Deneb specification aggregates ${valueName} from its dataset. Verify Power BI field summarization and data granularity to avoid aggregating an already summarized value twice; an explicit measure is preferable.`);
  return {
    denebSpec: { $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { name: 'dataset' }, mark, encoding, width: 'container', height: 'container', background: theme.background,
      config: { view: { stroke: null }, axis: { labelColor: theme.foreground, titleColor: theme.foreground, gridColor: theme.foreground, gridOpacity: 0.12 } } },
    denebFields,
  };
}

function pageFor(table, tables, model, brief, index, warnings, theme) {
  const metrics = metricsFor(table, model, brief, warnings);
  const { categories, dates } = fieldsFor(table, tables, model, brief, warnings);
  const visuals = [];
  const cardWidth = (1392 - 24 * (metrics.length - 1)) / metrics.length;
  for (let position = 0; position < metrics.length; position++) {
    visuals.push({ ...metrics[position], id: `page-${index + 1}-card-${position + 1}`, type: 'card', position: { x: 24 + position * (cardWidth + 24), y: 24, width: cardWidth, height: 136 } });
  }
  const metric = metrics[0], charts = [];
  const binding = Object.fromEntries(['table', 'value', 'aggregation', 'measure', 'suggestedDax'].filter(key => metric[key] !== undefined).map(key => [key, metric[key]]));
  if (categories[0]) charts.push({ ...binding, type: 'bar', title: `${metric.title} by ${categories[0].column}`, category: categories[0], rationale: 'Compare the metric across an existing categorical field. Apply a suitable Top N if the category contains many values.' });
  if (dates[0]) {
    charts.push({ ...binding, type: 'line', title: `${metric.title} over ${dates[0].column}`, category: dates[0], rationale: 'Show the metric along an existing date field. Choose a day, month, or year grain after reviewing the date range.' });
    warnings.push(`${table.name}: the trend uses a typed date field. No continuous calendar, marked date table, or time-intelligence calculation has been assumed.`);
  } else if (categories[1]) {
    const donut = /donut|composition|share|proportion/i.test(brief) && metric.aggregation !== 'average';
    charts.push({ ...binding, type: donut ? 'donut' : 'bar', title: `${metric.title} by ${categories[1].column}`, category: categories[1], rationale: donut ? 'Compare category contributions only after confirming the metric is additive and categories form meaningful parts of a whole. Limit slices for readability.' : 'Provide a second categorical breakdown using an actual model field.' });
    if (donut) warnings.push(`${table.name}: confirm the metric can be interpreted as parts of a whole before using the suggested donut visual.`);
  }
  for (let position = 0; position < charts.length; position++) {
    visuals.push({ ...charts[position], ...denebFor(charts[position], warnings, theme), id: `page-${index + 1}-chart-${position + 1}`, position: { x: 24 + position * 712, y: 184, width: charts.length === 1 ? 1392 : 680, height: 312 } });
  }
  const fields = (table.columns || []).filter(visible).slice(0, 8).map(column => ({ table: table.name, column: column.name }));
  if (fields.length) visuals.push({ id: `page-${index + 1}-table`, type: 'table', title: `${table.name} detail`, table: table.name, fields,
    rationale: 'Provide a detail table using existing columns. Row-level values appear only after loading the actual data in Power BI.',
    position: { x: 24, y: charts.length ? 520 : 184, width: 1392, height: charts.length ? 352 : 688 } });
  if (!charts.length) warnings.push(`${table.name}: no suitable categorical or connected date field was available for a chart. KPI and detail-table placeholders are provided.`);
  const slicers = [...categories.slice(0, 2), ...dates.slice(0, 1)];
  return { name: index === 0 ? 'Overview' : `${table.name} detail`, table: table.name, visuals, slicers, layout: { width: 1440, height: 900 } };
}

/** Build a deterministic metadata-based report blueprint, without executing DAX or inventing data. */
export function buildDashboard({ model: input, brief = '', audience = 'Executive', style = 'midnight', title = '' } = {}) {
  const model = validateModel(input);
  const requestBrief = textInput(brief, '', 4000, 'Dashboard brief');
  const requestedAudience = textInput(audience, 'Executive', 100, 'Dashboard audience');
  const requestedTitle = textInput(title, `${model.name || 'Power BI model'} dashboard`, 180, 'Dashboard title');
  if (typeof style !== 'string' || !Object.hasOwn(STYLES, style)) throw new Error('Unknown dashboard style. Choose midnight, violet, light, or slate.');
  const warnings = ['This dashboard is a metadata-based blueprint. The preview is schematic; no data values, DAX results, business insights, or executable Power BI report have been generated.'];
  const visibleTables = model.tables.filter(visible), selected = visibleTables.slice(0, 8);
  if (!selected.length) throw new Error('The model needs at least one visible table to build a dashboard.');
  if (visibleTables.length > selected.length) warnings.push(`The blueprint uses the first ${selected.length} visible tables. ${visibleTables.length - selected.length} additional table(s) were omitted to keep the dashboard focused.`);
  const briefLower = requestBrief.toLowerCase();
  selected.sort((left, right) => {
    const score = table => briefScore(table.name, briefLower) * 10 + (table.measures || []).filter(measureKind).length * 3 + (table.columns || []).filter(column => visible(column) && numeric(column) && !identifier(column, table, model)).length;
    return score(right) - score(left);
  });
  const theme = { ...STYLES[style], dataColors: [...STYLES[style].dataColors] };
  const pages = selected.map((table, index) => pageFor(table, selected, model, briefLower, index, warnings, theme));
  if (selected.length > 1 && !(model.relationships || []).some(relationship => relationship.isActive !== false)) warnings.push('No active relationships were supplied. Each table has its own page; cross-table filtering is not assumed.');
  if (selected.some(table => table.dataTypeInferred)) warnings.push('Imported column types were inferred from source values. Review types and identifiers before creating the semantic model.');
  if (requestBrief) warnings.push('The brief influences field and table priority through name matching. Review the generated bindings against your business question.');
  const buildSteps = [
    'Open Power BI Desktop and load the original data sources. This blueprint contains field metadata rather than rows or a deployable semantic model.',
    'Confirm each table’s grain, column data types, keys, and relationship cardinality. Create and verify the required active relationships before using cross-table filters.',
    'Import the exported theme JSON through View → Themes → Browse for themes.',
    'Create each blueprint page with a custom canvas of 1440 × 900 pixels. Place visuals using the listed positions and sizes.',
    'Bind each visual to its listed table, category, value, or existing measure. Create any proposed DAX measures only after reviewing their aggregation assumptions.',
    'For an exported Deneb specification, add the listed denebFields to a Deneb visual’s Values well, keep their display names, select Vega-Lite, and paste the specification. Verify Power BI summarization and rendering against source data.',
    'Add the listed slicers, choose date grouping, and configure interactions. Review Top N filters and category counts for readable charts.',
    'Replace schematic placeholders with actual Power BI visuals, verify calculations against source totals, and test filtering before sharing the report.',
    'Save the report as a PBIX file and publish through your Power BI workspace when ready. This app exports the blueprint, guide, and theme; it does not create or publish a PBIX.',
  ];
  return { title: requestedTitle, description: `${requestedAudience} dashboard blueprint for ${model.name || 'the supplied model'}, using actual fields from ${selected.length} visible table(s).`,
    audience: requestedAudience, brief: requestBrief, style, pages, theme, buildSteps, warnings: [...new Set(warnings)], source: 'rules' };
}

/** A portable Power BI Desktop build guide for the exact generated blueprint. */
export function dashboardMarkdown(plan) {
  if (!plan || plan.source !== 'rules' || !Array.isArray(plan.pages) || !Array.isArray(plan.buildSteps)) throw new Error('A generated dashboard blueprint is required.');
  const lines = [`# ${md(plan.title)}`, '', md(plan.description), '', `Audience: ${md(plan.audience)} · Theme: ${md(plan.theme?.name)}`, '', '## Build in Power BI Desktop', ''];
  plan.buildSteps.forEach((step, index) => lines.push(`${index + 1}. ${md(step)}`));
  for (const page of plan.pages) {
    lines.push('', `## ${md(page.name)}`, '', `Canvas: ${page.layout.width} × ${page.layout.height} pixels.`, '', '| Visual | Type | Actual model binding | Position (x, y) | Size |', '| --- | --- | --- | --- | --- |');
    for (const visual of page.visuals) {
      const bindings = [visual.category && `${visual.category.table}.${visual.category.column}`, visual.value && `${visual.value.table}.${visual.value.column} (${visual.aggregation})`, visual.measure && `${visual.measure.table}.[${visual.measure.name}]`, visual.aggregation === 'countRows' && `COUNTROWS(${visual.table})`, ...(visual.fields || []).map(field => `${field.table}.${field.column}`)].filter(Boolean);
      lines.push(`| ${md(visual.title)} | ${md(visual.type)} | ${bindings.map(md).join('; ')} | ${visual.position.x}, ${visual.position.y} | ${visual.position.width} × ${visual.position.height} |`);
    }
    if (page.slicers.length) lines.push('', `Slicers: ${page.slicers.map(field => md(`${field.table}.${field.column}`)).join('; ')}.`);
    for (const visual of page.visuals) {
      lines.push('', `### ${md(visual.title)}`, '', md(visual.rationale));
      if (visual.suggestedDax) lines.push('', 'Suggested measure; review before adding:', '', '```dax', visual.suggestedDax.replaceAll('```', ''), '```');
      if (visual.denebSpec) lines.push('', `Deneb fields: ${visual.denebFields.map(field => md(`${field.table}.${field.column || `[${field.measure}]`} (${field.role})`)).join('; ')}.`, '', 'A Vega-Lite specification is included in this visual’s blueprint. Add these actual fields to Deneb’s Values well and retain their display names before importing the specification.');
    }
  }
  lines.push('', '## Review notes', '');
  for (const warning of plan.warnings || []) lines.push(`- ${md(warning)}`);
  return lines.join('\n');
}
