import type { SaveDialogOptions } from "electron";
import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { DATA_KEYS, HilReportRequest, SCORE_FACTOR_LABELS } from "@reqflow/core";
import { ReqflowError } from "./dispatch";

export type SaveDialogFn = (
  opts: SaveDialogOptions,
) => Promise<{ canceled: boolean; filePath?: string }>;

export async function exportHilReportPdf(
  request: unknown,
  saveFn?: SaveDialogFn,
  renderPdf: (html: string) => Promise<Uint8Array> = renderReportPdf,
  writePdf: (path: string, bytes: Uint8Array) => Promise<void> = writeFile,
): Promise<{ path: string } | null> {
  const parsed = HilReportRequest.safeParse(request);
  if (!parsed.success) {
    throw new ReqflowError(
      "invalid_input",
      `Cannot export sample PDF: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const req = parsed.data;
  // Reject oversized samples rather than silently truncating verbatim content.
  if (Buffer.byteLength(JSON.stringify(req), "utf8") > 2_000_000) {
    throw new Error(
      "Sample report exceeds 2 MB. Select fewer data points; content is not truncated.",
    );
  }
  const save =
    saveFn ??
    (async (opts: SaveDialogOptions) => (await import("electron")).dialog.showSaveDialog(opts));
  const result = await save({
    title: "Export HIL Format-Check Sample",
    defaultPath: "hil-sample-report.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled) return null;
  if (!result.filePath) throw new Error("The PDF save dialog returned no file path.");
  const path =
    extname(result.filePath).toLowerCase() === ".pdf" ? result.filePath : `${result.filePath}.pdf`;
  const bytes = await renderPdf(generateReportHtml(req));
  await writePdf(path, bytes);
  return { path };
}

export function generateReportHtml(
  req: HilReportRequest,
  generatedAt = new Date().toISOString(),
): string {
  const esc = (value: unknown): string =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const field = (label: string, value: unknown) =>
    `<p><b>${esc(label)}:</b> <span class="text">${esc(value === "" || value == null ? "Not provided" : value)}</span></p>`;
  const list = (values: string[]) =>
    values.length
      ? `<ul>${values.map((v) => `<li class="text">${esc(v)}</li>`).join("")}</ul>`
      : "<p>None recorded.</p>";
  const section = (title: string, content: string) =>
    `<section><h2>${esc(title)}</h2>${content}</section>`;
  const { metadata: meta, selectedData: data, fullCounts, notes } = req;
  const ref = (id: string, key: (typeof DATA_KEYS)[number]) =>
    `${esc(id)} (${data[key].some((r) => r.id === id) ? "included in sample" : "not included in sample; inspect in app"})`;
  const references = (ids: string[], key: (typeof DATA_KEYS)[number]) =>
    ids.length ? ids.map((id) => ref(id, key)).join("<br>") : "None recorded.";
  const selected = DATA_KEYS.reduce((n, key) => n + data[key].length, 0);
  const total = Object.values(fullCounts).reduce((a, b) => a + b, 0);
  const counts = DATA_KEYS.map((key) => {
    const title = (key[0]!.toUpperCase() + key.slice(1)) as keyof typeof fullCounts;
    return `<tr><td>${title}</td><td>${data[key].length}</td><td>${fullCounts[title]}</td><td>${fullCounts[title] - data[key].length}</td></tr>`;
  }).join("");
  const names = new Map(meta.lineageSteps.map((s) => [s.id, s.label]));
  const lineage = `<table><thead><tr><th>Step / ID</th><th>Type</th><th>Workplace path</th></tr></thead><tbody>${meta.lineageSteps.map((s) => `<tr><td>${esc(s.label)}<br>${esc(s.id)}</td><td>${esc(s.kind)}</td><td>${esc(s.path.join(" / ") || "Root")}</td></tr>`).join("")}</tbody></table>
    <h3>Data routes</h3>${meta.lineageLinks.length ? list(meta.lineageLinks.map((l) => `${names.get(l.source)} [${l.sourceLabel || "output"}] -> ${names.get(l.target)} [${l.targetLabel || "input"}]`)) : "<p>No incoming routes.</p>"}`;
  const brief = data.requirements.length
    ? `<table><thead><tr><th>Candidate</th><th>Priority / evidence</th><th>Review attention</th></tr></thead><tbody>${data.requirements
        .map((r) => {
          const gaps = [
            ...(!r.targets.length ? ["No measurable targets recorded"] : []),
            ...(["C", "D"].includes(r.evidenceLevel)
              ? ["Weak / assumption-led evidence: validate before commitment"]
              : []),
            ...(r.conflictingFindingIds.length
              ? ["Conflicting evidence: cross-functional discussion needed"]
              : []),
            ...(r.findingIds.some((id) => !data.findings.some((f) => f.id === id))
              ? ["Supporting findings not included in sample; inspect in app"]
              : []),
            ...(r.sourceIds.some((id) => !data.sources.some((s) => s.id === id))
              ? ["Referenced sources not included in sample"]
              : []),
            ...(!r.priorityRationale ? ["Priority rationale not recorded"] : []),
            ...(r.uncertainties.length
              ? [`${r.uncertainties.length} recorded uncertainties need validation`]
              : []),
          ];
          return `<tr><td>${esc(r.id)}<br>${esc(r.title)}<br>Status: ${esc(r.status)}</td><td>${esc(r.priority ?? "Not prioritized")}<br>Evidence ${esc(r.evidenceLevel)}<br>Score ${r.score?.total ?? "not recorded"}</td><td>${list(gaps.length ? gaps : ["No listed format gaps; sample alone cannot establish decision readiness"])}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "<p>No requirements selected at this step. Check input structure and traceability before downstream requirement definition.</p>";
  const requirements = data.requirements
    .map(
      (r) => `<article><h3>${esc(r.id)} v${r.version}: ${esc(r.title)}</h3>
    ${field("Description", r.description)}${field("Category", r.category)}${field("Status", r.status)}${field("Priority", r.priority)}${field("Evidence level", r.evidenceLevel)}${field("Kano", r.kano)}${field("Prioritization rationale", r.priorityRationale)}
    <h4>Measurable targets and acceptance</h4>${list(r.targets.map((t) => `${t.metric}: ${t.target}. Acceptance: ${t.acceptance}`))}
    ${
      r.score
        ? `${field("Score", `${r.score.total}/100; suggested ${r.score.suggestedPriority}; ${r.score.method}; ${r.score.scoredAt}`)}<table><thead><tr><th>Factor</th><th>Value / 5</th><th>Weight</th><th>Rationale</th></tr></thead><tbody>${Object.entries(
            r.score.factors,
          )
            .map(
              ([key, factor]) =>
                `<tr><td>${esc(SCORE_FACTOR_LABELS[key as keyof typeof SCORE_FACTOR_LABELS])}</td><td>${factor.value}</td><td>${factor.weight}</td><td class="text">${esc(factor.note)}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : "<p>Score not recorded.</p>"
    }
    <h4>Assumptions</h4>${list(r.assumptions)}<h4>Uncertainties</h4>${list(r.uncertainties)}
    <h4>Supporting findings</h4>${references(r.findingIds, "findings")}<h4>Conflicting findings</h4>${references(r.conflictingFindingIds, "findings")}<h4>Sources</h4>${references(r.sourceIds, "sources")}
    ${field("Created", r.createdAt)}${field("Updated", r.updatedAt)}</article>`,
    )
    .join("");
  const findings = data.findings
    .map(
      (f) =>
        `<article><h3>${esc(f.id)}: ${esc(f.kind)}</h3>${field("Signal", f.statement)}${field("Category", f.category)}${field("Confidence", f.confidence)}${field("Mentions", f.mentions)}${field("In scope", f.inScope)}${field("Markets", f.markets.join(", "))}${f.evidence.map((e) => `<blockquote class="text">${esc(e.excerpt)}</blockquote>${field("Locator", e.locator)}<p>Source: ${ref(e.sourceId, "sources")}<br>Record: ${e.recordId ? ref(e.recordId, "records") : "Not linked"}</p>`).join("")}</article>`,
    )
    .join("");
  const records = data.records
    .map(
      (r) =>
        `<article><h3>${esc(r.id)}</h3>${field("Locator", r.locator)}${field("Language", r.language)}${field("Market", r.market)}<p>Source: ${ref(r.sourceId, "sources")}</p>${field("Original content", r.text)}${r.fields ? `<h4>Original structured columns</h4><pre>${esc(JSON.stringify(r.fields, null, 2))}</pre>` : ""}</article>`,
    )
    .join("");
  const sources = data.sources
    .map(
      (s) =>
        `<article><h3>${esc(s.id)}: ${esc(s.title)}</h3>${field("Type / origin", `${s.kind} / ${s.origin}`)}${field("Reliability", s.reliability)}${field("Publisher", s.publisher)}${field("Source URI", s.uri)}${field("Published", s.publishedAt)}${field("Retrieved", s.retrievedAt)}</article>`,
    )
    .join("");
  const themes = data.themes
    .map(
      (t) =>
        `<article><h3>${esc(t.id)}: ${esc(t.label)}</h3>${field("Summary", t.summary)}${field("Category", t.category)}<h4>Findings</h4>${references(t.findingIds, "findings")}</article>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>HIL Format-Check Sample</title><style>
    @page { size: A4; margin: 16mm; } body { font: 11px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #18202b; }
    h1 { font-size: 26px; border-bottom: 4px solid #176db6; padding-bottom: 10px; } h2 { font-size: 17px; color: #12538a; } h3 { font-size: 13px; } h1,h2,h3,h4 { break-after: avoid; }
    section { margin-top: 24px; } article { border-top: 1px solid #ccd4dd; padding: 8px 0; } p { margin: 5px 0; } .warning { background: #fff4df; border-left: 4px solid #986800; padding: 12px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; } th,td { border: 1px solid #ccd4dd; padding: 7px; vertical-align: top; } th { background: #eef3f8; } thead { display: table-header-group; }
    .text, pre { white-space: pre-wrap; } pre { font-size: 10px; } body,td,pre { overflow-wrap: anywhere; } blockquote { border-left: 3px solid #ccd4dd; padding-left: 12px; margin: 10px 0; } li { margin: 4px 0; }
    </style></head><body><h1>Human-in-the-Loop Review Brief</h1><p class="warning"><b>SAMPLE / FORMAT CHECK. NOT THE FULL DATASET. NOT AN APPROVAL.</b><br>Purposeful selection, not a statistically representative sample. ${selected} selected data points out of ${total}; ${total - selected} omitted. Export does not authorize continuing the workflow or approve requirements. May contain confidential source excerpts; share only with authorized reviewers.</p>
    ${field("Generated", generatedAt)}${field("Scope", `${meta.scope.vehicleLine} (${meta.scope.vehicleCode}), ${meta.scope.market}, ${meta.scope.horizonYears}-year horizon`)}${field("Provenance", meta.runId ? `Saved run ${meta.runId}; status ${meta.runStatus ?? "not recorded"}` : "Live source preview. Not a saved run or review record.")}${field("Sampled step", `${meta.currentStep.label} (${meta.currentStep.id})`)}${field("Review gate", meta.gate.label)}${field("Reviewer / approvals required", `${meta.gate.reviewer} / ${meta.gate.approvalsNeeded}`)}${field("Review instructions", meta.gate.instructions)}
    ${section("1. Management Brief", brief + "<h3>Human-authored next actions</h3><p>Report-only notes, not persisted assignments or audit signatures. PM must review complete evidence in the app before commitment.</p>" + field("Review objective", notes?.objective) + field("Owner / consulted functions", notes?.owner) + field("Next checkpoint", notes?.nextCheckpoint) + field("Open questions / validation action", notes?.openQuestions))}
    ${section("2. Coverage and Omissions", `<table><thead><tr><th>Dataset</th><th>Selected</th><th>Full count at step</th><th>Omitted</th></tr></thead><tbody>${counts}</tbody></table><p>Unselected references are not expanded. A reference absent from this PDF is not necessarily absent from the full dataset.</p>`)}
    ${section("3. Upstream Data Lineage", lineage)}${requirements ? section("Selected Requirements", requirements) : ""}${themes ? section("Selected Themes", themes) : ""}${findings ? section("Selected Findings and Verbatim Evidence", findings) : ""}${records ? section("Selected Records: Format Inspection", records) : ""}${sources ? section("Selected Source Register", sources) : ""}</body></html>`;
}

export async function renderReportPdf(html: string): Promise<Uint8Array> {
  const { BrowserWindow } = await import("electron");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return await Promise.race([
      (async () => {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        return await win.webContents.printToPDF({
          printBackground: true,
          pageSize: "A4",
          preferCSSPageSize: true,
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate:
            '<div style="font-size:8px;width:100%;text-align:center;color:#687080">Format-check sample | <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("PDF generation timed out after 15 seconds.")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}
