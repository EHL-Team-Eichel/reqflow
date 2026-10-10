import {
  BLOCK_SPECS,
  blockParamsSchema,
  blockPorts,
  defaultBlockParams,
  isBoundaryBlockKind,
  parseBlockParams,
  type BlockParams,
  type BlockPorts,
  type PaletteBlockKind,
} from "./blocks";
import { WorkflowGraph, type WorkflowBlock, type WorkflowEdge } from "./workflow";

/**
 * Pure, immutable operations on workflow graphs, shared by the editor and the engine.
 * Every operation returns a new graph and throws an Error with a user-readable message on
 * invalid input. Nothing is skipped silently.
 */

export interface Connection {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

export interface GraphIssue {
  path: string[]; // ids of the blocks whose inner workplaces lead to the problem ([] = top level)
  blockId?: string;
  edgeId?: string;
  message: string;
}

export function emptyGraph(): WorkflowGraph {
  return { blocks: [], edges: [] };
}

/** Deterministic, so connecting the same ports twice is detectable by id. */
export function edgeId(c: Connection): string {
  return `e-${c.source}.${c.sourcePort}-${c.target}.${c.targetPort}`;
}

/** Boundary ids derive from the parent id and port id, which are unique together. */
export function boundaryBlockId(parentId: string, portId: string): string {
  return `${parentId}--${portId}`;
}

const BOUNDARY_COLUMN_GAP = 520;
const BOUNDARY_ROW_GAP = 120;

/** The input and output blocks of an inner workplace: inputs on the left, outputs on the right. */
export function boundaryBlocks(parentId: string, ports: BlockPorts): WorkflowBlock[] {
  return [
    ...ports.inputs.map((port, i): WorkflowBlock => ({
      id: boundaryBlockId(parentId, port.id),
      kind: "block_input",
      label: port.label,
      position: { x: 0, y: i * BOUNDARY_ROW_GAP },
      params: { port: port.id },
    })),
    ...ports.outputs.map((port, i): WorkflowBlock => ({
      id: boundaryBlockId(parentId, port.id),
      kind: "block_output",
      label: port.label,
      position: { x: BOUNDARY_COLUMN_GAP, y: i * BOUNDARY_ROW_GAP },
      params: { port: port.id },
    })),
  ];
}

/** A new block with default params, and an inner workplace (boundaries only) if the kind has one. */
export function createBlock(
  kind: PaletteBlockKind,
  opts: { id: string; position: { x: number; y: number }; label?: string },
): WorkflowBlock {
  const spec = BLOCK_SPECS[kind];
  const params = defaultBlockParams(kind);
  const block: WorkflowBlock = {
    id: opts.id,
    kind,
    label: opts.label ?? spec.label,
    position: opts.position,
    params,
  };
  if (spec.hasInnerWorkplace) {
    block.inner = { blocks: boundaryBlocks(opts.id, spec.ports(params)), edges: [] };
  }
  return block;
}

/** Expand legacy splitters in memory; existing workplaces and saved files stay intact. */
export function withSplitterWorkplaces<T extends WorkflowGraph>(graph: T): T {
  let changed = false;
  const blocks = graph.blocks.map((block) => {
    let inner = block.inner;
    if (block.kind === "ai_splitter" && !inner) {
      const params = parseBlockParams(block.kind, block.params);
      inner = {
        blocks: boundaryBlocks(block.id, BLOCK_SPECS.ai_splitter.ports(params)),
        edges: [],
      };
    } else if (inner) {
      inner = withSplitterWorkplaces(inner);
    }
    if (inner === block.inner) return block;
    changed = true;
    return { ...block, inner };
  });
  return changed ? { ...graph, blocks } : graph;
}

/** Every block in the tree, depth-first, with the path of the workplace it sits on. */
export function* walkBlocks(
  graph: WorkflowGraph,
  path: string[] = [],
): Generator<{ block: WorkflowBlock; path: string[] }> {
  for (const block of graph.blocks) {
    yield { block, path };
    if (block.inner) yield* walkBlocks(block.inner, [...path, block.id]);
  }
}

/** "Raw", then "Raw 2", "Raw 3", … — unique across the whole workflow. */
export function nextBlockLabel(root: WorkflowGraph, base: string): string {
  const used = new Set([...walkBlocks(root)].map(({ block }) => block.label));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

function requireBlock(graph: WorkflowGraph, id: string): WorkflowBlock {
  const block = graph.blocks.find((b) => b.id === id);
  if (!block) throw new Error(`Block "${id}" is not on this workplace`);
  return block;
}

function replaceBlock(graph: WorkflowGraph, next: WorkflowBlock): WorkflowGraph {
  return { ...graph, blocks: graph.blocks.map((b) => (b.id === next.id ? next : b)) };
}

/** The workplace at `path` (block ids from the top level inward). */
export function graphAt(root: WorkflowGraph, path: readonly string[]): WorkflowGraph {
  let graph = root;
  for (const id of path) {
    const block = requireBlock(graph, id);
    if (!block.inner) throw new Error(`Block "${block.label}" has no inner workplace`);
    graph = block.inner;
  }
  return graph;
}

/** Replaces the workplace at `path` with `update(workplace)`, copying only the blocks on the path. */
export function updateGraphAt(
  root: WorkflowGraph,
  path: readonly string[],
  update: (graph: WorkflowGraph) => WorkflowGraph,
): WorkflowGraph {
  if (path.length === 0) return update(root);
  const [head, ...rest] = path as [string, ...string[]];
  const block = requireBlock(root, head);
  if (!block.inner) throw new Error(`Block "${block.label}" has no inner workplace`);
  return replaceBlock(root, { ...block, inner: updateGraphAt(block.inner, rest, update) });
}

/** True when an edge source → target would close a loop (target already reaches source). */
export function wouldCreateCycle(graph: WorkflowGraph, source: string, target: string): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const e of graph.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

export function checkConnection(graph: WorkflowGraph, c: Connection): ConnectionCheck {
  const source = graph.blocks.find((b) => b.id === c.source);
  const target = graph.blocks.find((b) => b.id === c.target);
  if (!source || !target) return { ok: false, reason: "Both blocks must be on this workplace." };
  if (source.id === target.id) return { ok: false, reason: "A block can't connect to itself." };
  if (!blockPorts(source).outputs.some((p) => p.id === c.sourcePort)) {
    return { ok: false, reason: `"${source.label}" has no output "${c.sourcePort}".` };
  }
  if (!blockPorts(target).inputs.some((p) => p.id === c.targetPort)) {
    return { ok: false, reason: `"${target.label}" has no input "${c.targetPort}".` };
  }
  if (graph.edges.some((e) => e.id === edgeId(c))) {
    return { ok: false, reason: "These ports are already connected." };
  }
  if (wouldCreateCycle(graph, c.source, c.target)) {
    return { ok: false, reason: "This connection would create a loop." };
  }
  return { ok: true };
}

/** Adds an edge. Several edges may enter one input (merged) or leave one output (fan-out). */
export function connect(graph: WorkflowGraph, c: Connection): WorkflowGraph {
  const check = checkConnection(graph, c);
  if (!check.ok) throw new Error(check.reason);
  const edge: WorkflowEdge = {
    id: edgeId(c),
    source: c.source,
    sourcePort: c.sourcePort,
    target: c.target,
    targetPort: c.targetPort,
  };
  return { ...graph, edges: [...graph.edges, edge] };
}

/** Removes blocks and their edges. Unknown ids are ignored, so repeated deletes are harmless. */
export function removeBlocks(graph: WorkflowGraph, ids: readonly string[]): WorkflowGraph {
  const remove = new Set(ids);
  const boundary = graph.blocks.find((b) => remove.has(b.id) && isBoundaryBlockKind(b.kind));
  if (boundary) {
    throw new Error(`"${boundary.label}" belongs to the parent block's ports and can't be deleted`);
  }
  return {
    blocks: graph.blocks.filter((b) => !remove.has(b.id)),
    edges: graph.edges.filter((e) => !remove.has(e.source) && !remove.has(e.target)),
  };
}

/** Removes edges. Unknown ids are ignored, so repeated deletes are harmless. */
export function removeEdges(graph: WorkflowGraph, ids: readonly string[]): WorkflowGraph {
  const remove = new Set(ids);
  return { ...graph, edges: graph.edges.filter((e) => !remove.has(e.id)) };
}

export function moveBlock(
  graph: WorkflowGraph,
  id: string,
  position: { x: number; y: number },
): WorkflowGraph {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error(`Invalid position for block "${id}"`);
  }
  return replaceBlock(graph, { ...requireBlock(graph, id), position });
}

export function renameBlock(graph: WorkflowGraph, id: string, label: string): WorkflowGraph {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Block names can't be empty");
  if (trimmed.length > 80) throw new Error("Block names can have at most 80 characters");
  return replaceBlock(graph, { ...requireBlock(graph, id), label: trimmed });
}

/** Keeps an inner workplace's boundary blocks in line with the parent's ports. */
export function syncBoundaries(
  inner: WorkflowGraph,
  parentId: string,
  ports: BlockPorts,
): WorkflowGraph {
  const wanted = boundaryBlocks(parentId, ports);
  const wantedIds = new Set(wanted.map((b) => b.id));
  const existing = new Map(inner.blocks.map((b) => [b.id, b]));
  const stale = inner.blocks
    .filter((b) => isBoundaryBlockKind(b.kind) && !wantedIds.has(b.id))
    .map((b) => b.id);
  const kept = inner.blocks.filter((b) => !stale.includes(b.id));
  const merged = kept.map((b) => {
    const w = wanted.find((x) => x.id === b.id);
    return w ? { ...b, label: w.label } : b;
  });
  const added = wanted.filter((b) => !existing.has(b.id));
  return {
    blocks: [...merged, ...added],
    edges: inner.edges.filter((e) => !stale.includes(e.source) && !stale.includes(e.target)),
  };
}

/**
 * Validates and sets a block's params. Edges on ports that no longer exist (a removed splitter
 * branch, say) are removed and returned, so the editor can tell the user.
 */
export function setBlockParams(
  graph: WorkflowGraph,
  id: string,
  params: BlockParams,
): { graph: WorkflowGraph; removedEdges: WorkflowEdge[] } {
  const block = requireBlock(graph, id);
  if (isBoundaryBlockKind(block.kind)) {
    throw new Error(`"${block.label}" is a port of the parent block and has no parameters`);
  }
  const next: WorkflowBlock = { ...block, params: parseBlockParams(block.kind, params) };
  const ports = blockPorts(next);
  if (next.inner) next.inner = syncBoundaries(next.inner, next.id, ports);
  else if (BLOCK_SPECS[block.kind].hasInnerWorkplace) {
    next.inner = { blocks: boundaryBlocks(next.id, ports), edges: [] };
  }
  const inputs = new Set(ports.inputs.map((p) => p.id));
  const outputs = new Set(ports.outputs.map((p) => p.id));
  const removedOuterEdges = graph.edges.filter(
    (e) =>
      (e.source === id && !outputs.has(e.sourcePort)) ||
      (e.target === id && !inputs.has(e.targetPort)),
  );
  const removed = new Set(removedOuterEdges.map((e) => e.id));
  const keptInnerEdges = new Set(next.inner?.edges.map((e) => e.id));
  const removedInnerEdges = block.inner?.edges.filter((e) => !keptInnerEdges.has(e.id)) ?? [];
  return {
    graph: {
      blocks: graph.blocks.map((b) => (b.id === id ? next : b)),
      edges: graph.edges.filter((e) => !removed.has(e.id)),
    },
    removedEdges: [...removedOuterEdges, ...removedInnerEdges],
  };
}

/** Every problem in the workflow, inner workplaces included. Empty array = valid. */
export function validateGraph(root: unknown): GraphIssue[] {
  const shape = WorkflowGraph.safeParse(root);
  if (!shape.success) {
    return shape.error.issues.map((i) => ({
      path: [],
      message: `${i.path.join(".") || "graph"}: ${i.message}`,
    }));
  }
  const issues: GraphIssue[] = [];
  const seen = new Set<string>();
  validateLevel(shape.data, [], null, seen, issues);
  return issues;
}

function validateLevel(
  graph: WorkflowGraph,
  path: string[],
  parent: WorkflowBlock | null,
  seen: Set<string>,
  issues: GraphIssue[],
): void {
  const add = (message: string, ref: { blockId?: string; edgeId?: string } = {}) =>
    issues.push({ path, ...ref, message });

  for (const block of graph.blocks) {
    const blockId = block.id;
    if (seen.has(blockId)) add(`Block id "${blockId}" is used more than once`, { blockId });
    seen.add(blockId);

    const params = blockParamsSchema(block.kind).safeParse(block.params);
    if (!params.success) {
      for (const i of params.error.issues) {
        add(`"${block.label}": ${i.path.join(".") || "params"}: ${i.message}`, { blockId });
      }
    }

    if (isBoundaryBlockKind(block.kind)) {
      if (!parent) add(`"${block.label}" can only sit inside an inner workplace`, { blockId });
      if (block.inner) add(`"${block.label}" can't have an inner workplace`, { blockId });
      continue;
    }

    const spec = BLOCK_SPECS[block.kind];
    if (spec.hasInnerWorkplace && !block.inner) {
      add(`"${block.label}" is missing its inner workplace`, { blockId });
    }
    if (!spec.hasInnerWorkplace && block.inner) {
      add(`"${block.label}" (${spec.label}) can't have an inner workplace`, { blockId });
    }
    if (block.inner) validateLevel(block.inner, [...path, blockId], block, seen, issues);
  }

  if (parent) {
    const ports = blockPorts(parent);
    for (const [kind, list] of [
      ["block_input", ports.inputs],
      ["block_output", ports.outputs],
    ] as const) {
      for (const port of list) {
        const count = graph.blocks.filter((b) => b.kind === kind && b.params.port === port.id);
        if (count.length !== 1) {
          add(`Port "${port.label}" needs exactly one ${kind} block, found ${count.length}`);
        }
      }
      const valid = new Set(list.map((p) => p.id));
      for (const b of graph.blocks.filter((b) => b.kind === kind)) {
        if (!valid.has(String(b.params.port))) {
          add(`"${b.label}" points to a port the parent block doesn't have`, { blockId: b.id });
        }
      }
    }
  }

  const edgeIds = new Set<string>();
  const blocksById = new Map(graph.blocks.map((b) => [b.id, b]));
  for (const edge of graph.edges) {
    const ref = { edgeId: edge.id };
    if (edgeIds.has(edge.id)) add(`Edge id "${edge.id}" is used more than once`, ref);
    edgeIds.add(edge.id);
    const source = blocksById.get(edge.source);
    const target = blocksById.get(edge.target);
    if (!source || !target) {
      add(`Edge "${edge.id}" connects a block that isn't on this workplace`, ref);
      continue;
    }
    if (source === target) add(`Edge "${edge.id}" connects "${source.label}" to itself`, ref);
    if (!blockPorts(source).outputs.some((p) => p.id === edge.sourcePort)) {
      add(`"${source.label}" has no output "${edge.sourcePort}"`, ref);
    }
    if (!blockPorts(target).inputs.some((p) => p.id === edge.targetPort)) {
      add(`"${target.label}" has no input "${edge.targetPort}"`, ref);
    }
  }

  // Kahn's algorithm: every block must be reachable in topological order.
  const indegree = new Map(graph.blocks.map((b) => [b.id, 0]));
  for (const e of graph.edges) {
    if (indegree.has(e.target)) indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const e of graph.edges.filter((e) => e.source === id)) {
      if (!indegree.has(e.target)) continue;
      const d = indegree.get(e.target)! - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (visited < graph.blocks.length) add("The blocks on this workplace form a loop");
}
