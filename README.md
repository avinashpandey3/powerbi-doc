# POWERBI-DOC
Toolkit for Power BI model documentation, DAX templates, and metadata analysis.

## Run locally

Requires Node.js 22 or newer. No packages or credentials are required.

```sh
npm start
```

The server listens on loopback port 3000. Override `PORT` to change the port or `HOST` to change the listening address. Run `npm test` for the core and HTTP integration tests.

## Deploy on Render (free)

The included `render.yaml` prepares a free Node.js web service. It runs the tests before startup, uses Node.js 24, listens on `0.0.0.0`, and exposes `/health` for platform health checks. No database, API keys, or paid services are configured.

1. Merge the deployment configuration into `main` on GitHub.
2. Sign in at [Render](https://dashboard.render.com/), connect your GitHub account, and choose **New → Blueprint**.
3. Select `avinashpandey3/powerbi-doc` and the `main` branch. Review the service and confirm that its instance type is **Free** before deploying.
4. After deployment succeeds, open the service URL provided by Render. Load the example and try documentation, DAX generation, and model analysis.

For a public repository, you can also start with [Deploy to Render](https://render.com/deploy?repo=https://github.com/avinashpandey3/powerbi-doc).

Free web services may sleep after inactivity and take time to wake up. Review Render's current free-tier limits during setup. Deploying the source to GitHub alone does not create a live service.

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
