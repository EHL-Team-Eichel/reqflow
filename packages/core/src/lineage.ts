import { blockPorts, isBoundaryBlockKind } from "./blocks";
import { graphAt } from "./graph";
import type { WorkflowBlock, WorkflowGraph } from "./workflow";

/**
 * Data lineage: every step data passes through on its way into one block — "how was this data
 * collected?". Used by the HIL review report, and reusable for any block.
 *
 * The trace crosses workplace borders. From a block's inner `block_input` it continues with whatever
 * feeds that port on the parent's workplace, and an upstream block with blocks inside it is traced
 * through its inner sub-flow (via its `block_output`), because that sub-flow produced its output.
 */

export interface LineageStep {
  block: WorkflowBlock;
  path: string[]; // workplace the block sits on ([] = top level), as in graphAt()
  /** Longest number of links from this step to the target (target = 0). Drives the layout. */
  distance: number;
}

export interface LineageLink {
  id: string;
  source: string; // block id (ids are unique across the whole workflow)
  target: string;
  /** Port names when they tell the story ("Must have" branch, "Input" of a custom block). */
  sourceLabel: string;
  targetLabel: string;
}

export interface Lineage {
  targetId: string;
  steps: LineageStep[]; // target first, then upstream in discovery order
  links: LineageLink[];
}

const hasContent = (graph: WorkflowGraph | undefined) =>
  !!graph?.blocks.some((b) => !isBoundaryBlockKind(b.kind));

const portLabel = (block: WorkflowBlock, side: "inputs" | "outputs", portId: string) =>
  blockPorts(block)[side].find((p) => p.id === portId)?.label ?? portId;

/** Traces everything upstream of `blockId` (which sits on the workplace at `path`). */
export function traceLineage(
  root: WorkflowGraph,
  path: readonly string[],
  blockId: string,
): Lineage {
  const steps = new Map<string, Omit<LineageStep, "distance">>();
  const links = new Map<string, LineageLink>();

  const findOn = (wpPath: string[], id: string): WorkflowBlock => {
    const block = graphAt(root, wpPath).blocks.find((b) => b.id === id);
    if (!block) throw new Error(`Block "${id}" is not on that workplace`);
    return block;
  };
  const link = (
    source: WorkflowBlock,
    sourcePort: string,
    target: WorkflowBlock,
    targetPort: string,
  ) => {
    const id = `${source.id}.${sourcePort}->${target.id}.${targetPort}`;
    links.set(id, {
      id,
      source: source.id,
      target: target.id,
      sourceLabel: portLabel(source, "outputs", sourcePort),
      targetLabel: portLabel(target, "inputs", targetPort),
    });
  };

  // Each queued item: a block whose inputs we still have to follow.
  const queue: { path: string[]; id: string }[] = [{ path: [...path], id: blockId }];
  steps.set(blockId, { block: findOn([...path], blockId), path: [...path] });

  const enqueue = (wpPath: string[], block: WorkflowBlock) => {
    if (steps.has(block.id)) return;
    steps.set(block.id, { block, path: wpPath });
    queue.push({ path: wpPath, id: block.id });
  };

  while (queue.length) {
    const { path: wpPath, id } = queue.shift()!;
    const block = steps.get(id)!.block;
    const graph = graphAt(root, wpPath);

    if (block.kind === "block_input") {
      // Leave the inner workplace: follow what feeds this port of the parent block.
      const parentId = wpPath.at(-1);
      if (!parentId) continue; // invalid graph (boundary on the top level): nothing to follow
      const parentPath = wpPath.slice(0, -1);
      const port = String(block.params.port);
      for (const e of graphAt(root, parentPath).edges) {
        if (e.target !== parentId || e.targetPort !== port) continue;
        const source = findOn(parentPath, e.source);
        links.set(`${source.id}.${e.sourcePort}->${block.id}.out`, {
          id: `${source.id}.${e.sourcePort}->${block.id}.out`,
          source: source.id,
          target: block.id,
          sourceLabel: portLabel(source, "outputs", e.sourcePort),
          targetLabel: block.label,
        });
        enqueue(parentPath, source);
      }
      continue;
    }

    // An upstream block that contains a sub-flow produced its output there: trace inside it.
    if (id !== blockId && hasContent(block.inner)) {
      const innerPath = [...wpPath, block.id];
      for (const out of block.inner!.blocks.filter((b) => b.kind === "block_output")) {
        const outId = `${out.id}.in->${block.id}.inner`;
        links.set(outId, {
          id: outId,
          source: out.id,
          target: block.id,
          sourceLabel: out.label,
          targetLabel: "",
        });
        enqueue(innerPath, out);
      }
      continue; // its own inputs are reached through its inner block_input boundaries
    }

    for (const e of graph.edges) {
      if (e.target !== id) continue;
      const source = findOn(wpPath, e.source);
      link(source, e.sourcePort, block, e.targetPort);
      enqueue(wpPath, source);
    }
  }

  // Longest distance to the target, over the (acyclic) links.
  const distance = new Map<string, number>([[blockId, 0]]);
  const outgoing = new Map<string, string[]>();
  for (const l of links.values())
    outgoing.set(l.source, [...(outgoing.get(l.source) ?? []), l.target]);
  const dist = (id: string, seen: Set<string>): number => {
    const known = distance.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // defensive: a cycle would be a graph error
    seen.add(id);
    const d = 1 + Math.max(...(outgoing.get(id) ?? []).map((t) => dist(t, seen)), -1);
    distance.set(id, d);
    return d;
  };

  return {
    targetId: blockId,
    steps: [...steps.values()].map((s) => ({ ...s, distance: dist(s.block.id, new Set()) })),
    links: [...links.values()],
  };
}
