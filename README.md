# POWERBI-DOC
Toolkit for Power BI model documentation, DAX templates, and metadata analysis.

## Run locally

Requires Node.js 22 or newer. No packages or credentials are required.

```sh
npm start
```

The server listens on loopback port 3000 (override with `PORT`). Run `npm test` for the core tests.

## First version

- Generate and download Markdown model documentation.
- Generate SUM, COUNTROWS, DISTINCTCOUNT, and calendar YTD measures with explanations.
- Review missing descriptions, disconnected tables, missing expressions, many-to-many relationships, and bidirectional filtering.

Load the built-in retail example or import normalized JSON using this structure:

```json
{
  "name": "Retail",
  "tables": [
    {
      "name": "Sales",
      "description": "One row per transaction",
      "columns": [{ "name": "Amount", "dataType": "decimal" }],
      "measures": [{ "name": "Revenue", "expression": "SUM('Sales'[Amount])" }]
    }
  ],
  "relationships": []
}
```

Relationships use `fromTable`, `fromColumn`, `toTable`, `toColumn`, `cardinality`, and `crossFilteringBehavior`. Inputs are limited to 2 MB. Metadata is sent to the workspace server for processing and is not persisted.

This version uses deterministic templates and metadata heuristics. It does not connect to Power BI, execute DAX, parse PBIX files, or use an AI provider. Review formulas and findings in Power BI Desktop. No account or API key is needed.
