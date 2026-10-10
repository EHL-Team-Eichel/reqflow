import {
  validateGraph,
  WorkflowRun,
  type AgentCollectionResult,
  type ProductScope,
  type ResearchDataset,
  type ReqflowApi,
  type Workflow,
  type WorkflowGraph,
} from "@reqflow/core";

type RunClient = {
  workflows: Pick<ReqflowApi["workflows"], "save">;
  runs: Pick<ReqflowApi["runs"], "start">;
};

const previewLimit = 20_000;
const previewMaxDepth = 32;
const previewMaxNodes = 5_000;
const previewTruncated = "\nSource preview truncated; full original available through export.";

function rawPrefixEnd(text: string, limit: number): number {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (
      (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
      (last === 13 && next === 10)
    )
      end--;
  }
  return end;
}

/** Cut serialized text only between complete escape tokens and Unicode code points. */
function jsonPrefixEnd(text: string, limit: number): number {
  const end = rawPrefixEnd(text, limit);
  let position = 0;
  while (position < end) {
    const code = text.charCodeAt(position);
    const next = text.charCodeAt(position + 1);
    const width =
      code === 92
        ? text.startsWith("\\r\\n", position)
          ? 4
          : text[position + 1] === "u"
            ? 6
            : 2
        : code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
          ? 2
          : 1;
    if (position + width > end) break;
    position += width;
  }
  return position;
}

/**
 * Display-only prefix of inert, plain IPC JSON. Never stringify containers or invoke getters/hooks.
 * Both output (including its marker) and traversal are bounded; the input remains untouched.
 */
export function boundedRawPreview(input: unknown): string {
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  let length = 0;
  let visited = 0;
  let truncated = false;

  const append = (text: string) => {
    if (truncated) return;
    const remaining = previewLimit - length;
    const end = text.length <= remaining ? text.length : jsonPrefixEnd(text, remaining);
    if (end) chunks.push(text.slice(0, end));
    length += end;
    if (end < text.length) truncated = true;
  };
  const appendString = (text: string) => {
    const end = rawPrefixEnd(text, previewLimit - length);
    // A single escaped leaf allocates at most 6 * 20,000 + 2 characters, never the full input.
    const encoded = JSON.stringify(text.slice(0, end));
    append(end < text.length ? encoded.slice(0, -1) : encoded);
    if (end < text.length) truncated = true;
  };
  const canVisit = () => {
    if (length >= previewLimit || visited >= previewMaxNodes) truncated = true;
    return !truncated;
  };
  const visit = (value: unknown, depth: number): void => {
    if (!canVisit()) return;
    visited++;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      append(JSON.stringify(value));
      return;
    }
    if (typeof value === "string") {
      appendString(value);
      return;
    }
    if (typeof value !== "object" || depth >= previewMaxDepth || ancestors.has(value)) {
      truncated = true;
      return;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      truncated = true;
      return;
    }
    ancestors.add(value);
    append(array ? "[" : "{");
    let count = 0;
    const member = (key: string, field: PropertyDescriptor | undefined) => {
      if (field && !("value" in field)) {
        truncated = true;
        return;
      }
      append(`${count ? "," : ""}\n${"  ".repeat(depth + 1)}`);
      if (truncated) return;
      if (!array) {
        appendString(key);
        if (truncated) return;
        append(": ");
      }
      if (!canVisit()) return;
      visit(field ? field.value : null, depth + 1);
      count++;
    };
    if (array) {
      const size = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
      for (let index = 0; index < size; index++) {
        if (!canVisit()) break;
        const key = String(index);
        member(key, Object.getOwnPropertyDescriptor(value, key));
      }
    } else {
      // Do not allocate Object.keys/entries for the entire input or read property values directly.
      for (const key in value) {
        if (!canVisit()) break;
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (field?.enumerable) member(key, field);
      }
    }
    if (count) append(`\n${"  ".repeat(depth)}`);
    append(array ? "]" : "}");
    ancestors.delete(value);
  };

  visit(input, 0);
  const preview = chunks.join("");
  if (!truncated) return preview;
  const end = jsonPrefixEnd(preview, previewLimit - previewTruncated.length);
  return preview.slice(0, end) + previewTruncated;
}

/** Save the root snapshot, never just the currently open inner workplace. */
export async function startEditorWorkflow(
  client: RunClient,
  graph: WorkflowGraph,
  scope: ProductScope,
  workflowId?: string,
  onSaved?: (workflow: Workflow) => void,
): Promise<WorkflowRun> {
  const issues = validateGraph(graph);
  if (issues.length)
    throw new Error(`Invalid workflow: ${issues.map((issue) => issue.message).join("; ")}`);
  if (!graph.blocks.length) throw new Error("Add a block before running the workflow.");
  const workflow = await client.workflows.save({
    ...(workflowId ? { id: workflowId } : {}),
    name: "Research workflow",
    scope: structuredClone(scope),
    ...structuredClone(graph),
  });
  onSaved?.(workflow);
  return WorkflowRun.parse(await client.runs.start(workflow.id));
}

const settled = new Set(["completed", "failed", "cancelled", "waiting_for_review"]);
export function isRunBusy(run: WorkflowRun | null): boolean {
  return (
    !!run &&
    (run.status === "queued" || run.status === "running" || run.status === "waiting_for_review")
  );
}

/** Main can push completion before start/cancel returns its older snapshot. */
export function reconcileRun(current: WorkflowRun | null, next: WorkflowRun): WorkflowRun {
  if (
    current?.id === next.id &&
    settled.has(current.status) &&
    (next.status === "queued" || next.status === "running")
  )
    return current;
  return next;
}

export function collectionSummary(result: AgentCollectionResult): string {
  switch (result.status) {
    case "blocked":
      return "Blocked — permission or provider approval required";
    case "missing_credentials":
      return "No credentials configured";
    case "empty":
      return "No matching records";
    case "partial":
      return "Partial collection — review limitations";
    case "error":
      return "Collection failed";
    case "cancelled":
      return "Collection cancelled";
    case "success":
      return "Collection complete";
  }
}

export async function cancelWorkflow(
  client: { runs: Pick<ReqflowApi["runs"], "cancel"> },
  run: WorkflowRun,
): Promise<WorkflowRun> {
  if (!isRunBusy(run)) throw new Error("Only active runs can be cancelled.");
  const next = WorkflowRun.parse(await client.runs.cancel(run.id));
  if (next.id !== run.id) throw new Error("Cancellation returned another run.");
  return next;
}

export function exportResearchDataset(
  client: { exports: Pick<ReqflowApi["exports"], "research"> },
  dataset: ResearchDataset,
  format: "json" | "xlsx" | "csv",
): Promise<{ path: string } | null> {
  return client.exports.research({ runId: dataset.runId, format });
}
