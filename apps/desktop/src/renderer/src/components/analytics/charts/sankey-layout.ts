/**
 * Layered Sankey layout: pure geometry, no DOM. Sankey.tsx draws what this returns.
 * Columns follow each node's stage, all columns share one scale so bands are comparable, and
 * nothing is relaxed iteratively: the order of `nodes` decides the order inside a column.
 */

export interface SankeyNodeInput {
  id: string;
  stage: number;
  label: string;
  color: string;
}

export interface SankeyLinkInput {
  source: string;
  target: string;
  value: number;
}

export interface SankeyNode extends SankeyNodeInput {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** max(inflow, outflow): the height of the node follows it. */
  value: number;
}

export interface SankeyLink extends SankeyLinkInput {
  /** Top of the band where it leaves its source node. */
  y0: number;
  /** Top of the band where it enters its target node. */
  y1: number;
  width: number;
  /** Closed SVG path of the band, with cubic curves. */
  path: string;
}

const DEFAULT_NODE_WIDTH = 12;
const DEFAULT_PADDING = 10;

/** x of a stage column: stage 0 starts at the left edge, `maxStage` ends at the right edge. */
export function stageX(stage: number, maxStage: number, width: number, nodeWidth: number): number {
  if (maxStage <= 0) return 0;
  return (stage / maxStage) * Math.max(0, width - nodeWidth);
}

/**
 * Lays out nodes in columns by `stage` and stacks the bands at each node: outgoing bands in the
 * vertical order of their targets, incoming bands in the order of their sources, so bands do not
 * cross inside a node. Node height is max(inflow, outflow) times one common scale, and the column
 * with the most flow fills the height; shorter columns are centred. Links with a value that is not
 * above zero, an unknown node id, or a target that is not in a later stage are dropped. Nodes
 * without any flow are left out. Throws on duplicate node ids and on invalid stages.
 */
export function layoutSankey(
  nodes: SankeyNodeInput[],
  links: SankeyLinkInput[],
  opts: { width: number; height: number; nodeWidth?: number; nodePadding?: number },
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const nodeWidth = opts.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const padding = opts.nodePadding ?? DEFAULT_PADDING;

  const byId = new Map<string, SankeyNodeInput>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Sankey: duplicate node id "${node.id}"`);
    if (!Number.isInteger(node.stage) || node.stage < 0) {
      throw new Error(`Sankey: node "${node.id}" needs a whole, non-negative stage`);
    }
    byId.set(node.id, node);
  }

  const valid = links.filter((link) => {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    return (
      source !== undefined &&
      target !== undefined &&
      Number.isFinite(link.value) &&
      link.value > 0 &&
      target.stage > source.stage
    );
  });

  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const link of valid) {
    outflow.set(link.source, (outflow.get(link.source) ?? 0) + link.value);
    inflow.set(link.target, (inflow.get(link.target) ?? 0) + link.value);
  }

  const shown = nodes.filter(
    (node) => (inflow.get(node.id) ?? 0) > 0 || (outflow.get(node.id) ?? 0) > 0,
  );
  if (shown.length === 0) return { nodes: [], links: [] };

  const value = new Map<string, number>();
  for (const node of shown) {
    value.set(node.id, Math.max(inflow.get(node.id) ?? 0, outflow.get(node.id) ?? 0));
  }
  const maxStage = Math.max(...shown.map((node) => node.stage));

  const columns = new Map<number, SankeyNodeInput[]>();
  for (const node of shown) {
    const column = columns.get(node.stage);
    if (column) column.push(node);
    else columns.set(node.stage, [node]);
  }

  // One scale for every column: the fullest column fills the height.
  const columnTotal = (column: SankeyNodeInput[]) =>
    column.reduce((sum, node) => sum + value.get(node.id)!, 0);
  let scale = Number.POSITIVE_INFINITY;
  for (const column of columns.values()) {
    const room = opts.height - padding * (column.length - 1);
    scale = Math.min(scale, room / columnTotal(column));
  }
  scale = Math.max(0, scale);

  const placed = new Map<string, SankeyNode>();
  for (const [stage, column] of columns) {
    const x0 = stageX(stage, maxStage, opts.width, nodeWidth);
    const contentHeight = columnTotal(column) * scale + padding * (column.length - 1);
    let y = Math.max(0, (opts.height - contentHeight) / 2);
    for (const node of column) {
      const height = value.get(node.id)! * scale;
      placed.set(node.id, {
        ...node,
        value: value.get(node.id)!,
        x0,
        x1: x0 + nodeWidth,
        y0: y,
        y1: y + height,
      });
      y += height + padding;
    }
  }

  const widths = valid.map((link) => link.value * scale);
  const outgoing = new Map<string, number[]>();
  const incoming = new Map<string, number[]>();
  valid.forEach((link, i) => {
    outgoing.set(link.source, [...(outgoing.get(link.source) ?? []), i]);
    incoming.set(link.target, [...(incoming.get(link.target) ?? []), i]);
  });

  const fromY = new Array<number>(valid.length).fill(0);
  const toY = new Array<number>(valid.length).fill(0);
  for (const [id, list] of outgoing) {
    list.sort(
      (a, b) => placed.get(valid[a]!.target)!.y0 - placed.get(valid[b]!.target)!.y0 || a - b,
    );
    let y = placed.get(id)!.y0;
    for (const i of list) {
      fromY[i] = y;
      y += widths[i]!;
    }
  }
  for (const [id, list] of incoming) {
    list.sort(
      (a, b) => placed.get(valid[a]!.source)!.y0 - placed.get(valid[b]!.source)!.y0 || a - b,
    );
    let y = placed.get(id)!.y0;
    for (const i of list) {
      toY[i] = y;
      y += widths[i]!;
    }
  }

  const laidOut: SankeyLink[] = valid.map((link, i) => {
    const source = placed.get(link.source)!;
    const target = placed.get(link.target)!;
    const width = widths[i]!;
    return {
      ...link,
      y0: fromY[i]!,
      y1: toY[i]!,
      width,
      path: bandPath(source.x1, target.x0, fromY[i]!, toY[i]!, width),
    };
  });

  return { nodes: shown.map((node) => placed.get(node.id)!), links: laidOut };
}

/** Band between two columns: top and bottom edges as cubic curves, closed for filling. */
function bandPath(xFrom: number, xTo: number, yFrom: number, yTo: number, width: number): string {
  const mid = (xFrom + xTo) / 2;
  const p = (n: number) => Math.round(n * 100) / 100;
  return [
    `M${p(xFrom)} ${p(yFrom)}`,
    `C${p(mid)} ${p(yFrom)} ${p(mid)} ${p(yTo)} ${p(xTo)} ${p(yTo)}`,
    `L${p(xTo)} ${p(yTo + width)}`,
    `C${p(mid)} ${p(yTo + width)} ${p(mid)} ${p(yFrom + width)} ${p(xFrom)} ${p(yFrom + width)}`,
    "Z",
  ].join("");
}
