import {
  blockPorts,
  isBoundaryBlockKind,
  validateGraph,
  WorkflowGraph as GraphSchema,
  type WorkflowGraph,
} from "@reqflow/core";

export interface EditorProblem {
  id: string;
  path: string[];
  blockId?: string;
  edgeId?: string;
  message: string;
  severity: "error" | "warning";
}

export function workflowProblems(root: WorkflowGraph): EditorProblem[] {
  const problems: EditorProblem[] = [];
  const add = (path: string[], message: string, blockId?: string, edgeId?: string) => {
    const id = JSON.stringify([path, blockId, edgeId, message]);
    if (!problems.some((problem) => problem.id === id))
      problems.push({ id, path, blockId, edgeId, message, severity: "error" });
  };
  try {
    if (!GraphSchema.safeParse(root).success) {
      add([], "The workflow graph has an invalid shape.");
      return problems;
    }
    for (const issue of validateGraph(root))
      add(issue.path, issue.message, issue.blockId, issue.edgeId);
  } catch {
    add([], "The workflow graph could not be validated. Check its block parameters.");
  }

  const seen = new Set<WorkflowGraph>();
  const inspect = (graph: WorkflowGraph, path: string[]) => {
    if (seen.has(graph)) return;
    seen.add(graph);
    for (const block of graph.blocks ?? []) {
      if (isBoundaryBlockKind(block.kind)) {
        if (block.kind === "block_output" && !graph.edges.some((edge) => edge.target === block.id))
          add(path, `Inner output "${block.label}" is not connected.`, block.id);
        continue;
      }
      let ports;
      try {
        ports = blockPorts(block);
      } catch {
        add(path, `"${block.label}" has invalid parameters.`, block.id);
        continue;
      }
      if (block.kind === "raw") {
        if (block.params.source === "excel" && !block.params.file)
          add(path, `"${block.label}" needs an uploaded file.`, block.id);
        if (block.params.source === "database") {
          if (!String(block.params.connection ?? "").trim())
            add(path, `"${block.label}" needs a database connection.`, block.id);
          if (!String(block.params.query ?? "").trim())
            add(path, `"${block.label}" needs a read-only query.`, block.id);
          if (block.params.dbType !== "sqlite")
            add(path, `"${block.label}" uses an unsupported database type.`, block.id);
        }
      }
      const connected = (portId: string) =>
        graph.edges.some((edge) => edge.target === block.id && edge.targetPort === portId);
      if (block.kind === "add_to_car") {
        if (
          !ports.inputs
            .filter((port) => !port.id.startsWith("ctx-"))
            .some((port) => connected(port.id))
        )
          add(
            path,
            `"${block.label}" needs at least one connected priority input. Context inputs are optional.`,
            block.id,
          );
      } else if (block.kind === "analytics") {
        if (!ports.inputs.some((port) => connected(port.id)))
          add(path, `"${block.label}" needs at least one connected input.`, block.id);
      } else
        for (const port of ports.inputs)
          if (!connected(port.id))
            add(path, `"${block.label}": input "${port.label}" is not connected.`, block.id);
      if (block.inner) {
        const builtIn =
          ["research", "ai_filter", "ai_splitter"].includes(block.kind) &&
          !block.inner.edges.length &&
          block.inner.blocks.every((child) => isBoundaryBlockKind(child.kind));
        if (!builtIn) inspect(block.inner, [...path, block.id]);
      }
    }
  };
  if (Array.isArray(root.blocks) && Array.isArray(root.edges)) inspect(root, []);
  return problems;
}
