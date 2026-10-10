import type { WorkflowGraph } from "@reqflow/core";
import type { NodeRegistry } from "./registry";

export interface GraphValidationError {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly errors: GraphValidationError[],
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  registry: NodeRegistry,
): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const nodeMap = new Map<string, (typeof graph.nodes)[number]>();

  // 1. Check duplicate node IDs
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      errors.push({
        nodeId: node.id,
        message: `Duplicate node id "${node.id}"`,
      });
    }
    nodeMap.set(node.id, node);
  }

  // 2. Validate node types and config schemas
  for (const node of graph.nodes) {
    if (!registry.has(node.type)) {
      errors.push({
        nodeId: node.id,
        message: `Unknown node type "${node.type}" for node "${node.id}"`,
      });
      continue;
    }

    const def = registry.get(node.type);
    const parsed = def.configSchema.safeParse(node.config);
    if (!parsed.success) {
      errors.push({
        nodeId: node.id,
        message: `Invalid configuration for node "${node.id}": ${parsed.error.message}`,
      });
    }
  }

  // 3. Validate edges
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push({
        edgeId: edge.id,
        message: `Duplicate edge id "${edge.id}"`,
      });
    }
    edgeIds.add(edge.id);

    if (!nodeMap.has(edge.source)) {
      errors.push({
        edgeId: edge.id,
        message: `Edge "${edge.id}" source "${edge.source}" does not exist in graph nodes`,
      });
    }
    if (!nodeMap.has(edge.target)) {
      errors.push({
        edgeId: edge.id,
        message: `Edge "${edge.id}" target "${edge.target}" does not exist in graph nodes`,
      });
    }
    if (edge.source === edge.target) {
      errors.push({
        edgeId: edge.id,
        message: `Self-loop detected on node "${edge.source}" in edge "${edge.id}"`,
      });
    }
  }

  // 4. Cycle detection (only if all edge endpoints are valid)
  if (errors.length === 0) {
    try {
      topologicalSort(graph);
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function topologicalSort(graph: WorkflowGraph): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }

  for (const edge of graph.edges) {
    const current = inDegree.get(edge.target) ?? 0;
    inDegree.set(edge.target, current + 1);
    const neighbors = adj.get(edge.source);
    if (neighbors) {
      neighbors.push(edge.target);
    }
  }

  const queue: string[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(nodeId);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    const neighbors = adj.get(current) ?? [];
    for (const neighbor of neighbors) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  if (order.length !== graph.nodes.length) {
    throw new Error("Workflow graph contains a cycle");
  }

  return order;
}

export function getDownstreamNodeIds(graph: WorkflowGraph, startNodeId: string): Set<string> {
  const downstream = new Set<string>();
  const adj = new Map<string, string[]>();

  for (const node of graph.nodes) {
    adj.set(node.id, []);
  }
  for (const edge of graph.edges) {
    adj.get(edge.source)?.push(edge.target);
  }

  const queue = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adj.get(current) ?? [];
    for (const next of neighbors) {
      if (!downstream.has(next)) {
        downstream.add(next);
        queue.push(next);
      }
    }
  }

  return downstream;
}
