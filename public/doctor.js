const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const svgNode = (tag, attributes = {}) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, value);
  return element;
};

export function createDoctor({ getModel, status, showError, run, download }) {
  let view = "overview",
    analysis,
    plan,
    config,
    aiController,
    aiBusy = false,
    aiEpoch = 0;
  let history = [],
    valid = false,
    generatedDax = "",
    dashboardRevision = 0;
  const data = () => {
    try {
      return getModel();
    } catch {
      return null;
    }
  };
  const metric = (value, label) => {
    const item = node("div");
    item.append(node("strong", value), node("span", label));
    return item;
  };
  const section = (title, description) => {
    const item = node("section", undefined, "paper-section");
    item.append(node("h3", title));
    if (description) item.append(node("p", description));
    return item;
  };

  function renderDocument() {
    const target = $("docs-preview");
    target.replaceChildren();
    const model = data();
    if (!model) {
      target.append(
        node("h2", "Start with your model."),
        node(
          "p",
          "Import files or load the example to explore your model reference.",
        ),
      );
      return;
    }
    target.append(
      node("span", "POWERBI DOCTOR / MODEL REFERENCE", "paper-label"),
    );
    if (view === "overview") {
      target.append(
        node("h2", model.name || "Untitled model"),
        node(
          "p",
          model.description ||
            "A reference to the structure and calculations behind your report.",
        ),
      );
      const stats = node("div", undefined, "paper-stats");
      stats.append(
        metric(model.tables.length, "TABLES"),
        metric(
          model.tables.reduce(
            (n, table) => n + (table.columns || []).length,
            0,
          ),
          "COLUMNS",
        ),
        metric(
          model.tables.reduce(
            (n, table) => n + (table.measures || []).length,
            0,
          ),
          "MEASURES",
        ),
      );
      target.append(stats);
      target.append(node("h3", "Inside the model"));
      const list = node("div", undefined, "paper-table-list");
      model.tables.forEach((table, index) => {
        const row = node("div", undefined, "paper-table-row"),
          body = node("div");
        body.append(
          node("strong", table.name),
          node(
            "p",
            table.description ||
              "Add a description to explain the purpose and grain.",
          ),
        );
        row.append(
          node(
            "span",
            String(index + 1).padStart(2, "0"),
            "paper-table-number",
          ),
          body,
          node("span", `${(table.columns || []).length} columns`),
        );
        list.append(row);
      });
      target.append(list);
    } else if (view === "dictionary") {
      target.append(node("h2", "Data dictionary"));
      for (const table of model.tables) {
        const part = section(table.name, table.description);
        if (table.sampledRowCount !== undefined)
          part.append(
            node(
              "p",
              `Types inferred from ${table.sampledRowCount.toLocaleString()} of ${table.rowCount.toLocaleString()} data rows. Review inferred types.`,
            ),
          );
        const grid = node("table"),
          head = node("thead"),
          headings = node("tr");
        ["Column", "Type", "Description"].forEach((text) =>
          headings.append(node("th", text)),
        );
        head.append(headings);
        grid.append(head);
        const body = node("tbody");
        for (const column of table.columns || []) {
          const row = node("tr");
          row.append(
            node("td", column.name),
            node("td", column.dataType || "Unspecified"),
            node("td", column.description || "—"),
          );
          body.append(row);
        }
        grid.append(body);
        part.append(grid);
        target.append(part);
      }
    } else if (view === "measures") {
      target.append(node("h2", "Saved measures"));
      let count = 0;
      for (const table of model.tables)
        for (const measure of table.measures || []) {
          const part = node("article", undefined, "paper-measure");
          part.append(
            node("span", table.name, "paper-label"),
            node("h3", measure.name),
            node("p", measure.description || "Description not supplied."),
            node("pre", measure.expression || "Expression not supplied."),
          );
          target.append(part);
          count++;
        }
      if (!count)
        target.append(
          node(
            "p",
            "No measures supplied. Use DAX Lab to create a starting point, then add reviewed measures to model metadata.",
          ),
        );
    } else {
      target.append(node("h2", "Model relationships"));
      for (const relation of model.relationships || [])
        target.append(
          section(
            `${relation.fromTable}.${relation.fromColumn} → ${relation.toTable}.${relation.toColumn}`,
            `${relation.cardinality || "Cardinality unspecified"} · ${relation.crossFilteringBehavior || "Direction unspecified"}${relation.isActive === false ? " · Inactive" : ""}`,
          ),
        );
      if (!model.relationships?.length)
        target.append(
          node(
            "p",
            "No relationships supplied. Data imports describe fields; add verified model relationships separately.",
          ),
        );
    }
  }
  for (const button of document.querySelectorAll(".doc-tab"))
    button.onclick = () => {
      view = button.dataset.docView;
      for (const tab of document.querySelectorAll(".doc-tab")) {
        const active = tab === button;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", String(active));
      }
      renderDocument();
    };

  function renderMap() {
    const target = $("relationship-map"),
      list = $("relationship-list");
    target.replaceChildren();
    list.replaceChildren();
    const model = data();
    if (!model) return;
    const tables = model.tables.slice(0, 16),
      columns = tables.length > 4 ? 3 : 2,
      width = columns * 340,
      height = Math.max(150, Math.ceil(tables.length / columns) * 145);
    const svg = svgNode("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `Relationship map of ${tables.length} tables. Full connections listed below.`,
    });
    const positions = new Map(
      tables.map((table, index) => [
        table.name,
        {
          x: (index % columns) * 340 + 20,
          y: Math.floor(index / columns) * 145 + 20,
        },
      ]),
    );
    const defs = svgNode("defs"),
      marker = svgNode("marker", {
        id: "map-arrow",
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 5,
        markerHeight: 5,
        orient: "auto-start-reverse",
      });
    marker.append(svgNode("path", { d: "M0 0 L10 5 L0 10Z", fill: "#a7f3d0" }));
    defs.append(marker);
    svg.append(defs);
    const relations = model.relationships || [];
    for (const relation of relations.slice(0, 100)) {
      const from = positions.get(relation.fromTable),
        to = positions.get(relation.toTable);
      if (from && to)
        svg.append(
          svgNode("path", {
            d: `M${from.x + 140} ${from.y + 52} L${to.x + 140} ${to.y + 52}`,
            stroke: "#a7f3d0",
            "stroke-opacity": 0.45,
            "stroke-width": 2,
            fill: "none",
            "stroke-dasharray": relation.isActive === false ? "5 5" : "",
            "marker-end": "url(#map-arrow)",
          }),
        );
      list.append(
        node(
          "p",
          `${relation.fromTable}.${relation.fromColumn} → ${relation.toTable}.${relation.toColumn} · ${relation.cardinality || "Cardinality unspecified"}${relation.isActive === false ? " · Inactive" : ""}`,
        ),
      );
    }
    for (const table of tables) {
      const { x, y } = positions.get(table.name),
        group = svgNode("g");
      group.append(
        svgNode("rect", {
          x,
          y,
          width: 280,
          height: 105,
          rx: 8,
          fill: "#14202b",
          stroke: "#344a57",
        }),
      );
      const title = svgNode("title");
      title.textContent = table.name;
      group.append(title);
      const label = svgNode("text", {
        x: x + 17,
        y: y + 28,
        fill: "#dfeaf1",
        "font-size": 13,
        "font-weight": 600,
      });
      label.textContent =
        table.name.length > 30 ? table.name.slice(0, 28) + "…" : table.name;
      const counts = svgNode("text", {
        x: x + 17,
        y: y + 50,
        fill: "#a7f3d0",
        "font-size": 10,
      });
      counts.textContent = `${(table.columns || []).length} columns · ${(table.measures || []).length} measures`;
      const detail = svgNode("text", {
        x: x + 17,
        y: y + 78,
        fill: "#849aab",
        "font-size": 10,
      });
      detail.textContent = (table.columns || [])
        .slice(0, 3)
        .map((column) => column.name)
        .join(" · ")
        .slice(0, 36);
      group.append(label, counts, detail);
      svg.append(group);
    }
    target.append(svg);
    $("map-caption").textContent =
      tables.length < model.tables.length
        ? `Showing ${tables.length} of ${model.tables.length} tables`
        : `${relations.length} declared connections`;
    if (!relations.length)
      list.append(
        node("p", "No relationships supplied; no connections are inferred."),
      );
    if (relations.length > 100)
      list.append(
        node(
          "p",
          "Map lists the first 100 relationships. Export model JSON for the complete relationship list.",
        ),
      );
  }
  function renderFindings() {
    if (!analysis) return;
    const target = $("findings"),
      severity = $("severity-filter").value;
    target.replaceChildren();
    const findings = analysis.findings.filter(
      (finding) => severity === "all" || severity === finding.severity,
    );
    for (const finding of findings) {
      const item = node("article", undefined, `finding ${finding.severity}`),
        content = node("div");
      item.append(node("span", finding.severity.toUpperCase(), "severity"));
      content.append(
        node("span", finding.category, "finding-category"),
        node("h3", finding.title),
        node("p", finding.detail),
      );
      if (finding.recommendation)
        content.append(node("p", finding.recommendation, "recommendation"));
      item.append(content);
      target.append(item);
    }
    if (!findings.length)
      target.append(
        node(
          "p",
          "No findings in this view. Validate model behavior in Power BI.",
          "quiet-empty",
        ),
      );
  }
  $("severity-filter").onchange = renderFindings;
  $("review-dax").onclick = async () => {
    const epoch = aiEpoch,
      expression = $("dax-review-input").value || generatedDax;
    $("review-dax").disabled = true;
    $("dax-review-result").replaceChildren();
    try {
      const result = await run("/api/dax-review", {
        expression,
        model: getModel(),
      });
      if (
        epoch !== aiEpoch ||
        ($("dax-review-input").value &&
          $("dax-review-input").value !== expression)
      )
        return;
      for (const finding of result.findings) {
        const part = node("article", undefined, "finding info");
        part.append(node("h3", finding.title), node("p", finding.detail));
        $("dax-review-result").append(part);
      }
      $("dax-review-result").append(node("p", result.notice, "tool-note"));
      status("Expression guidance ready. Validate the expression in Power BI.");
    } catch (error) {
      if (epoch === aiEpoch)
        $("dax-review-result").append(node("p", error.message, "ai-error"));
    } finally {
      $("review-dax").disabled = false;
    }
  };
  function setAnalysis(result) {
    analysis = result;
    $("findings").hidden = false;
    $("analysis-empty").hidden = true;
    $("health-score").textContent = result.score;
    $("health-gauge").style.setProperty("--score", result.score);
    $("health-title").textContent = result.counts.critical
      ? "Start with the critical findings."
      : result.counts.warning
        ? "A few things deserve a closer look."
        : "A good foundation to build on.";
    $("score-explanation").textContent = result.scoreExplanation;
    $("analysis-summary").textContent = `${result.counts.total} findings`;
    renderFindings();
    renderMap();
  }

  const binding = (visual) =>
    [
      visual.category && `${visual.category.table}.${visual.category.column}`,
      visual.measure && `${visual.measure.table}.[${visual.measure.name}]`,
      visual.value &&
        `${visual.value.table}.${visual.value.column} (${visual.aggregation})`,
      visual.aggregation === "countRows" && `COUNTROWS(${visual.table})`,
    ]
      .filter(Boolean)
      .join(" · ");
  function renderDashboard() {
    if (!plan) return;
    const page = plan.pages[Number($("dashboard-page").value) || 0],
      canvas = $("dashboard-canvas"),
      bindings = $("dashboard-bindings");
    canvas.replaceChildren();
    bindings.replaceChildren();
    canvas.style.backgroundColor = plan.theme.background;
    canvas.style.color = plan.theme.foreground;
    canvas.style.setProperty("--canvas-accent", plan.theme.dataColors[0]);
    for (const visual of page.visuals) {
      const tile = node("article", undefined, "visual-schematic");
      for (const [key, number] of Object.entries(visual.position))
        tile.style[key === "x" ? "left" : key === "y" ? "top" : key] =
          `${(number / (key === "x" || key === "width" ? page.layout.width : page.layout.height)) * 100}%`;
      tile.append(
        node("h4", visual.title),
        node("span", visual.type.toUpperCase()),
      );
      const symbol = node("div", undefined, "schematic-symbol");
      if (visual.type === "card") symbol.textContent = "—";
      else if (visual.type === "bar") {
        const bars = node("div", undefined, "schematic-bars");
        for (let i = 0; i < 4; i++) bars.append(node("i"));
        symbol.append(bars);
      } else if (visual.type === "line")
        symbol.append(node("div", undefined, "schematic-line"));
      else if (visual.type === "donut")
        symbol.append(node("div", undefined, "schematic-ring"));
      else symbol.textContent = "⋯  /  ⋯  /  ⋯";
      tile.append(symbol);
      canvas.append(tile);
      const card = node("article", undefined, "binding-card");
      card.append(
        node("h4", visual.title),
        node(
          "p",
          binding(visual) ||
            (visual.fields || [])
              .map((field) => `${field.table}.${field.column}`)
              .join(" · "),
          "binding-fields",
        ),
        node("p", visual.rationale),
      );
      if (visual.suggestedDax) card.append(node("pre", visual.suggestedDax));
      if (visual.denebSpec) {
        const button = node("button", "Download Deneb spec", "button compact");
        button.onclick = () => {
          download(
            JSON.stringify(visual.denebSpec, null, 2),
            `${visual.id}-deneb.json`,
            "application/json",
          );
          status(
            "Deneb specification exported. Add its listed fields in Power BI.",
          );
        };
        card.append(
          node(
            "p",
            `Deneb fields: ${visual.denebFields.map((field) => `${field.table}.${field.column || field.measure}`).join(" · ")}`,
          ),
          button,
        );
      }
      bindings.append(card);
    }
    canvas.append(
      node(
        "span",
        "DESIGN PREVIEW · SOURCE DATA IS NOT PLOTTED",
        "schematic-footer",
      ),
    );
  }
  function setDashboard(result) {
    plan = result;
    $("dashboard-empty").hidden = true;
    $("dashboard-result").hidden = false;
    $("dashboard-page").replaceChildren(
      ...plan.pages.map((page, index) => {
        const option = node("option", page.name);
        option.value = index;
        return option;
      }),
    );
    $("build-steps").replaceChildren(
      ...plan.buildSteps.map((step) => node("li", step)),
    );
    $("dashboard-warnings").replaceChildren(
      ...plan.warnings.map((warning) => node("p", warning)),
    );
    renderDashboard();
  }
  $("dashboard-page").onchange = renderDashboard;
  for (const id of [
    "dashboard-title",
    "dashboard-brief",
    "dashboard-audience",
    "dashboard-style",
  ])
    $(id).addEventListener("input", () => {
      dashboardRevision++;
      plan = undefined;
      $("dashboard-result").hidden = true;
      $("dashboard-empty").hidden = false;
    });
  $("export-blueprint").onclick = () => {
    if (plan)
      download(
        JSON.stringify(plan, null, 2),
        "dashboard-blueprint.json",
        "application/json",
      );
  };
  $("export-theme").onclick = () => {
    if (plan)
      download(
        JSON.stringify(plan.theme, null, 2),
        "powerbi-theme.json",
        "application/json",
      );
  };
  $("export-build-guide").onclick = () => {
    if (!plan) return;
    const lines = [
      `# ${plan.title}`,
      "",
      plan.description,
      "",
      "## Build in Power BI Desktop",
      "",
      ...plan.buildSteps.map((step, index) => `${index + 1}. ${step}`),
    ];
    for (const page of plan.pages) {
      lines.push(
        "",
        `## ${page.name}`,
        "",
        `Canvas: ${page.layout.width} × ${page.layout.height}`,
      );
      for (const visual of page.visuals) {
        lines.push(
          "",
          `### ${visual.title}`,
          "",
          binding(visual) || visual.table,
          "",
          visual.rationale,
          "",
          `Position: ${visual.position.x}, ${visual.position.y}; size ${visual.position.width} × ${visual.position.height}`,
        );
        if (visual.suggestedDax)
          lines.push(
            "",
            "```dax",
            visual.suggestedDax.replaceAll("```", ""),
            "```",
          );
      }
    }
    lines.push(
      "",
      "## Review notes",
      "",
      ...plan.warnings.map((warning) => `- ${warning}`),
    );
    download(lines.join("\n"), "dashboard-build-guide.md", "text/markdown");
  };

  const suggestions = {
    documentation: [
      "Explain this model to a new analyst.",
      "Which descriptions would make this model easier to understand?",
    ],
    dax: [
      "Create a measure using the selected model fields.",
      "Explain row context and filter context for this model.",
    ],
    analysis: [
      "Review the model grain and relationship design.",
      "Prioritize the structural improvements in this model.",
    ],
    dashboard: [
      "Suggest a report layout for the decision in my brief.",
      "How can I make this report accessible?",
    ],
    powerquery: [
      "Explain query folding and how to preserve it.",
      "Help me write M to clean a date column.",
    ],
  };
  function updateAi() {
    const configured = Boolean(config?.ai?.configured);
    $("ask-ai").disabled =
      !configured ||
      !valid ||
      aiBusy ||
      !$("ai-prompt").value.trim() ||
      (config?.ai?.accessRequired && !$("assistant-token").value);
    $("ask-ai").setAttribute("aria-busy", String(aiBusy));
    $("ask-ai").querySelector("span").textContent = aiBusy
      ? "Thinking…"
      : "Ask PowerBI Doctor";
  }
  function setMode(mode) {
    $("ai-mode").value = mode;
    $("ai-intent-field").hidden = mode !== "dax";
    $("ai-expression-field").hidden = mode !== "dax";
    $("ai-suggestions").replaceChildren(
      ...suggestions[mode].map((prompt) => {
        const button = node("button", prompt, "suggestion");
        button.onclick = () => {
          $("ai-prompt").value = prompt;
          updateAi();
          $("ai-prompt").focus();
        };
        return button;
      }),
    );
    $("ai-prompt").placeholder = suggestions[mode][0];
    updateAi();
  }
  $("ai-mode").onchange = () => setMode($("ai-mode").value);
  $("ai-prompt").addEventListener("input", updateAi);
  $("assistant-token").addEventListener("input", updateAi);
  $("ask-dax-ai").onclick = () => {
    setMode("dax");
    if (generatedDax) $("ai-expression").value = generatedDax;
    $("ai-pane").scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("ai-prompt").focus();
  };
  function clearAi() {
    aiEpoch++;
    aiController?.abort();
    aiController = undefined;
    aiBusy = false;
    history = [];
    $("ai-history").replaceChildren();
    $("ai-history-header").hidden = true;
    $("ai-error").hidden = true;
    updateAi();
  }
  $("clear-ai").onclick = clearAi;
  const appendMessage = (role, text) => {
    const item = node("article", undefined, `ai-message ${role}`);
    item.append(
      node("span", role === "user" ? "YOU" : "POWERBI DOCTOR", "message-role"),
      node("pre", text),
    );
    $("ai-history").append(item);
    $("ai-history-header").hidden = false;
    while ($("ai-history").children.length > 20)
      $("ai-history").firstChild.remove();
    return item;
  };
  $("ask-ai").onclick = async () => {
    if ($("ask-ai").disabled) return;
    const epoch = aiEpoch,
      controller = new AbortController();
    aiController = controller;
    aiBusy = true;
    updateAi();
    $("ai-error").hidden = true;
    const prompt = $("ai-prompt").value.trim(),
      mode = $("ai-mode").value;
    const request = {
      mode,
      prompt: mode === "dax" ? `${$("ai-intent").value}: ${prompt}` : prompt,
      model: getModel(),
      expression: mode === "dax" ? $("ai-expression").value : undefined,
      history: history
        .slice(-8)
        .map((turn) => ({ ...turn, content: turn.content.slice(0, 8000) })),
    };
    try {
      const headers = { "Content-Type": "application/json" };
      if (config.ai.accessRequired)
        headers["X-Assistant-Token"] = $("assistant-token").value;
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Assistant request failed.");
      if (epoch !== aiEpoch) return;
      appendMessage("user", prompt);
      const item = appendMessage("assistant", payload.result.text);
      item.append(node("p", payload.result.notice, "message-notice"));
      for (const source of payload.result.sources || [])
        if (/^https:\/\/learn\.microsoft\.com\//.test(source.url)) {
          const link = node("a", source.title);
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
        }
      history.push(
        { role: "user", content: request.prompt },
        { role: "assistant", content: payload.result.text },
      );
      history = history.slice(-8);
      $("ai-prompt").value = "";
      status("Assistant response ready. Review assumptions before use.");
    } catch (error) {
      if (epoch === aiEpoch && error.name !== "AbortError") {
        $("ai-error").textContent = error.message;
        $("ai-error").hidden = false;
      }
    } finally {
      if (epoch === aiEpoch) {
        aiBusy = false;
        aiController = undefined;
        updateAi();
      }
    }
  };
  async function loadConfig() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error();
      config = await response.json();
      const ai = config.ai,
        configured = Boolean(ai.configured),
        provider = ai.provider || "AI";
      $("ai-provider-label").textContent = configured
        ? `${provider} · ${ai.model} · configured`
        : "AI not configured · built-in tools ready";
      $("rail-ai-status").textContent = configured
        ? `${provider} configured`
        : "Built-in tools ready";
      $("rail-ai-dot").classList.toggle("muted", !configured);
      $("ai-provider-status")
        .querySelector(".status-dot")
        .classList.toggle("muted", !configured);
      $("ai-setup").hidden = configured;
      $("assistant-token-field").hidden = !configured || !ai.accessRequired;
    } catch {
      config = undefined;
      $("ai-provider-label").textContent =
        "AI settings unavailable · reload to retry";
      $("rail-ai-status").textContent = "Built-in tools ready";
      $("ai-setup").hidden = false;
    }
    updateAi();
  }
  setMode("documentation");
  loadConfig();

  return {
    sync() {
      valid = Boolean(data());
      $("rail-model-name").textContent =
        data()?.name || (valid ? "Untitled model" : "Model needs attention");
      renderDocument();
      renderMap();
      updateAi();
    },
    reset() {
      clearAi();
      analysis = undefined;
      plan = undefined;
      generatedDax = "";
      $("dax-review-result").replaceChildren();
      $("dax-review-input").value = "";
      $("ai-expression").value = "";
      $("download-html").disabled = true;
      $("dashboard-result").hidden = true;
      $("dashboard-empty").hidden = false;
      $("health-score").textContent = "—";
      $("health-gauge").style.setProperty("--score", 0);
      $("health-title").textContent = "A closer look at your model.";
      $("score-explanation").textContent =
        "Run a check for an explained metadata score. This does not measure query speed or data quality.";
      $("docs-ready-status").textContent = "Live metadata preview";
    },
    activate(panel) {
      const modes = {
        docs: "documentation",
        dax: "dax",
        analysis: "analysis",
        dashboard: "dashboard",
      };
      setMode(modes[panel]);
      $("current-tool").textContent = {
        docs: "Documentation",
        dax: "DAX Lab",
        analysis: "Model Doctor",
        dashboard: "Dashboard Studio",
      }[panel];
    },
    setAnalysis,
    setDashboard,
    getDashboardRevision: () => dashboardRevision,
    setDax(expression) {
      generatedDax = expression;
      if (!expression) return;
      const output = $("dax-output");
      output.replaceChildren();
      const tokens =
        /'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|\b(?:SUM|AVERAGE|MIN|MAX|DIVIDE|COUNTROWS|DISTINCTCOUNT|CALCULATE|REMOVEFILTERS|TOTALYTD|DATESINPERIOD|DATEADD|VAR|RETURN|MONTH|YEAR|DAY)\b/g;
      let cursor = 0;
      for (const match of expression.matchAll(tokens)) {
        output.append(
          document.createTextNode(expression.slice(cursor, match.index)),
        );
        output.append(
          node(
            "span",
            match[0],
            match[0][0] === "'" || match[0][0] === "["
              ? "dax-field"
              : "dax-keyword",
          ),
        );
        cursor = match.index + match[0].length;
      }
      output.append(document.createTextNode(expression.slice(cursor)));
    },
    documented() {
      $("download-html").disabled = false;
      $("docs-ready-status").textContent = "Ready to export";
    },
  };
}
