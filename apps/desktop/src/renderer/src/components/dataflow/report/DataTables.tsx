import { type PipelineData } from "@reqflow/core";
import { CATEGORY_LABELS } from "@reqflow/core";

interface Props {
  data: PipelineData;
  filter: string;
}

const match = (filter: string, ...texts: (string | undefined)[]) => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return texts.some((t) => t?.toLowerCase().includes(f));
};

function Empty() {
  return (
    <tr>
      <td colSpan={10} className="px-4 py-8 text-center text-muted">
        Nothing here.
      </td>
    </tr>
  );
}

export function SourcesTable({ data, filter }: Props) {
  const rows = data.sources.filter((s) =>
    match(filter, s.title, s.kind, s.origin, s.reliability, s.publisher),
  );
  return (
    <table data-testid="data-table" className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-panel text-muted shadow-sm">
        <tr>
          <th className="px-3 py-2 font-medium">Title</th>
          <th className="px-3 py-2 font-medium">Kind</th>
          <th className="px-3 py-2 font-medium">Origin</th>
          <th className="px-3 py-2 font-medium">Reliability</th>
          <th className="px-3 py-2 font-medium">Publisher</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((s) => (
            <tr key={s.id} className="border-b border-line hover:bg-panel-2">
              <td className="px-3 py-2 text-ink">{s.title}</td>
              <td className="px-3 py-2 text-muted">{s.kind}</td>
              <td className="px-3 py-2 text-muted">
                {s.origin === "bmw_internal" ? "BMW" : "Web"}
              </td>
              <td className="px-3 py-2 text-muted">{s.reliability || "—"}</td>
              <td className="px-3 py-2 text-muted">{s.publisher || "—"}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export function RecordsTable({ data, filter }: Props) {
  const sourceById = Object.fromEntries(data.sources.map((s) => [s.id, s.title]));
  const rows = data.records.filter((r) =>
    match(filter, r.text, sourceById[r.sourceId], r.locator, r.language),
  );
  return (
    <table data-testid="data-table" className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-panel text-muted shadow-sm">
        <tr>
          <th className="px-3 py-2 font-medium w-1/2">Text</th>
          <th className="px-3 py-2 font-medium">Source</th>
          <th className="px-3 py-2 font-medium">Locator</th>
          <th className="px-3 py-2 font-medium">Language</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((r) => (
            <tr key={r.id} className="border-b border-line hover:bg-panel-2">
              <td className="px-3 py-2 text-ink">
                <div className="line-clamp-3" title={r.text}>
                  {r.text}
                </div>
              </td>
              <td
                className="px-3 py-2 text-muted truncate max-w-[150px]"
                title={sourceById[r.sourceId]}
              >
                {sourceById[r.sourceId] || r.sourceId}
              </td>
              <td className="px-3 py-2 text-muted">{r.locator || "—"}</td>
              <td className="px-3 py-2 text-muted">{r.language || "—"}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export function FindingsTable({ data, filter }: Props) {
  const rows = data.findings.filter((f) =>
    match(
      filter,
      f.kind,
      f.statement,
      CATEGORY_LABELS[f.category],
      String(f.mentions),
      f.inScope ? "yes" : `no — ${f.outOfScopeReason || ""}`,
    ),
  );
  return (
    <table data-testid="data-table" className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-panel text-muted shadow-sm">
        <tr>
          <th className="px-3 py-2 font-medium">Kind</th>
          <th className="px-3 py-2 font-medium w-1/3">Statement</th>
          <th className="px-3 py-2 font-medium">Category</th>
          <th className="px-3 py-2 font-medium text-right">Mentions</th>
          <th className="px-3 py-2 font-medium text-right">Confidence</th>
          <th className="px-3 py-2 font-medium">In scope</th>
          <th className="px-3 py-2 font-medium text-right">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((f) => (
            <tr key={f.id} className="border-b border-line hover:bg-panel-2">
              <td className="px-3 py-2 text-muted">{f.kind}</td>
              <td className="px-3 py-2 text-ink">{f.statement}</td>
              <td className="px-3 py-2 text-muted">{CATEGORY_LABELS[f.category]}</td>
              <td className="px-3 py-2 text-muted text-right">{f.mentions}</td>
              <td className="px-3 py-2 text-muted text-right">
                {f.confidence !== undefined ? `${Math.round(f.confidence * 100)}%` : "—"}
              </td>
              <td className="px-3 py-2 text-muted">
                {f.inScope ? "yes" : `no — ${f.outOfScopeReason || ""}`}
              </td>
              <td className="px-3 py-2 text-muted text-right">{f.evidence.length}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export function ThemesTable({ data, filter }: Props) {
  const rows = data.themes.filter((t) =>
    match(filter, t.label, t.summary, CATEGORY_LABELS[t.category]),
  );
  return (
    <table data-testid="data-table" className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-panel text-muted shadow-sm">
        <tr>
          <th className="px-3 py-2 font-medium">Label</th>
          <th className="px-3 py-2 font-medium w-1/2">Summary</th>
          <th className="px-3 py-2 font-medium">Category</th>
          <th className="px-3 py-2 font-medium text-right">Findings</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((t) => (
            <tr key={t.id} className="border-b border-line hover:bg-panel-2">
              <td className="px-3 py-2 text-ink">{t.label}</td>
              <td className="px-3 py-2 text-muted">{t.summary}</td>
              <td className="px-3 py-2 text-muted">{CATEGORY_LABELS[t.category]}</td>
              <td className="px-3 py-2 text-muted text-right">{t.findingIds.length}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export function RequirementsTable({ data, filter }: Props) {
  const rows = data.requirements.filter((r) =>
    match(filter, r.id, r.title, r.priority, r.evidenceLevel, r.status),
  );
  return (
    <table data-testid="data-table" className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-panel text-muted shadow-sm">
        <tr>
          <th className="px-3 py-2 font-medium">ID</th>
          <th className="px-3 py-2 font-medium w-1/3">Title</th>
          <th className="px-3 py-2 font-medium">Priority</th>
          <th className="px-3 py-2 font-medium">Evidence level</th>
          <th className="px-3 py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((r) => (
            <tr key={r.id} className="border-b border-line hover:bg-panel-2">
              <td className="px-3 py-2 text-muted font-mono">{r.id}</td>
              <td className="px-3 py-2 text-ink">{r.title}</td>
              <td className="px-3 py-2 text-muted">{r.priority}</td>
              <td className="px-3 py-2 text-muted">{r.evidenceLevel}</td>
              <td className="px-3 py-2 text-muted">{r.status}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
