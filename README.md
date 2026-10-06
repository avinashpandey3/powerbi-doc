# POWERBI-DOC
Toolkit for Power BI model documentation, DAX templates, and metadata analysis.

## Run locally

Requires Node.js 22 or newer. No API keys or credentials are required.

```sh
npm ci
npm start
```

The server listens on loopback port 3000. Override `PORT` to change the port or `HOST` to change the listening address. Run `npm test` for the core and HTTP integration tests.

## Deploy on Render (free)

The included `render.yaml` prepares a free Node.js web service. It installs locked dependencies with `npm ci`, runs the tests before startup, uses Node.js 24, listens on `0.0.0.0`, and exposes `/health` for platform health checks. No database, API keys, or paid services are configured.

1. Merge the deployment configuration into `main` on GitHub.
2. Sign in at [Render](https://dashboard.render.com/), connect your GitHub account, and choose **New → Blueprint**.
3. Select `avinashpandey3/powerbi-doc` and the `main` branch. Review the service and confirm that its instance type is **Free** before deploying.
4. After deployment succeeds, open the service URL provided by Render. Load the example and try documentation, DAX generation, and model analysis.

For a public repository, you can also start with [Deploy to Render](https://render.com/deploy?repo=https://github.com/avinashpandey3/powerbi-doc).

Free web services may sleep after inactivity and take time to wake up. Review Render's current free-tier limits during setup. Deploying the source to GitHub alone does not create a live service.

## First version

- Build editable model metadata from supported data and metadata files, with multi-file import and JSON model export.
- Generate and download Markdown model documentation.
- Generate SUM, COUNTROWS, DISTINCTCOUNT, and calendar YTD measures with explanations.
- Review missing descriptions, disconnected tables, missing expressions, many-to-many relationships, and bidirectional filtering.

## File import

Choose **Replace model** to combine a batch into a new model, or **Add tables** to extend the current model. Import up to 10 files at once. If any file fails, the existing model stays unchanged. Conflicting table names get a suffix and metadata relationships are remapped to match. DAX expressions keep their original text; an import warning prompts you to review table references after a rename.

| Format | Imported model content |
| --- | --- |
| CSV, TSV, delimited TXT | One table per file; first row supplies column names. Comma, tab, semicolon, and pipe delimiters are supported. |
| Excel XLSX | One table per nonempty worksheet; first populated row supplies headers. Cached formula results may inform types; formulas are never executed. |
| JSON | Normalized model metadata, a BIM-style `model` object, an array of records, or a `rows`/`data` record array. |
| JSONL / NDJSON | One record object per nonempty line. |
| XML | One root containing repeated flat record elements, such as `<rows><row><Amount>12.50</Amount></row></rows>`. No attributes, nested fields, or DTDs. |
| Power BI BIM | Tables, columns, DAX measures, and relationships from exported Tabular metadata. |

Tabular imports infer `string`, `int64`, `decimal`, `boolean`, and ISO `dateTime` columns. Leading-zero identifiers remain strings, mixed types fall back to strings, and empty columns default to strings. JSON nested fields are summarized as string columns with a warning. Review inferred types in the model JSON. Data rows are processed in the workspace and are not retained in the model or saved to disk.

Data files do not describe Power BI measures or relationships. Add these to the model JSON or import BIM/model metadata that contains them. The result is a documentation model, not a deployable Power BI semantic model or PBIX file.

Uploads default to **10 MB per file**. Set `MAX_UPLOAD_MB` to a positive whole number to change this limit, then restart or redeploy the service. For example:

```sh
MAX_UPLOAD_MB=25 npm start
```

On Render, add `MAX_UPLOAD_MB=25` in the service's **Environment** settings and redeploy. The UI reads the active limit from `/api/limits`, so its label and validation match the server. Zero does not mean unlimited, and invalid settings fail startup with a clear error.

The original 2 MB upload cap was a conservative setting for the free hosting tier, not a file-format restriction. Imports are parsed in memory, and compressed workbooks can expand far beyond their upload size. An unlimited upload would risk exhausting memory or restarting the service. Raising the upload limit does not remove separate parsing limits; very large datasets need streaming or background processing and suitable hosting resources.

Other limits: 2 MB for editable/combined model JSON; 50,000 data rows per file/workbook; 512 columns per table; 128 tables per metadata file/workbook. Workbooks must be unencrypted, expand to at most 20 MB, and contain at most 250,000 cells. Headers must be nonempty and unique. Text files must be UTF-8.

Legacy XLS, ODS, Parquet, PBIX, PBIP, TMDL, PDF, and image files are not supported. Convert spreadsheets to XLSX/CSV or export Power BI model metadata as BIM/JSON. New formats can be added through the adapters in `importers.js`.

Use **Export model JSON** to save inferred or edited metadata for reuse. Markdown documentation has a separate export action. Load the built-in retail example or import normalized JSON using this structure:

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

Relationships use `fromTable`, `fromColumn`, `toTable`, `toColumn`, `cardinality`, and `crossFilteringBehavior`. Uploaded files and model metadata are sent to the workspace server for processing and are not persisted.

This version uses deterministic templates and metadata heuristics. It does not connect to Power BI, execute DAX, parse PBIX files, or use an AI provider. Review formulas and findings in Power BI Desktop. No account or API key is needed.
