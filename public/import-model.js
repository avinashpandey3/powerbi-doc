// Combine metadata without retaining data rows or silently overwriting tables.
export function combineModels(models, { existing, mode = 'replace' } = {}) {
  if (!models.length) throw new Error('Choose at least one file.');
  if (!['replace', 'append'].includes(mode)) throw new Error('Choose a valid import mode.');
  const base = mode === 'append' ? existing : models[0];
  if (!base || !Array.isArray(base.tables)) throw new Error('Fix the current model before adding tables.');
  const result = structuredClone(base);
  if (mode === 'replace') { result.tables = []; result.relationships = []; }
  else result.relationships ||= [];
  const names = new Set(result.tables.map(table => table.name.toLowerCase()));
  const warnings = [];
  for (const input of models) {
    const mapping = new Map();
    let renamed = false;
    for (const original of input.tables) {
      const table = structuredClone(original);
      let name = table.name, suffix = 2;
      while (names.has(name.toLowerCase())) name = `${table.name}_${suffix++}`;
      if (name !== table.name) { renamed = true; warnings.push(`Table "${table.name}" was renamed to "${name}" to keep names unique.`); }
      mapping.set(table.name, name); names.add(name.toLowerCase()); table.name = name;
      result.tables.push(table);
    }
    for (const relationship of input.relationships || []) result.relationships.push({
      ...structuredClone(relationship),
      fromTable: mapping.get(relationship.fromTable),
      toTable: mapping.get(relationship.toTable)
    });
    if (renamed && input.tables.some(table => [...(table.measures || []), ...(table.columns || [])].some(field => field.expression))) {
      warnings.push('DAX expressions were not rewritten for renamed tables. Review references to the original table names before using those expressions.');
    }
  }
  return { model: result, warnings };
}
