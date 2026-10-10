import {
  boundaryBlockId,
  connect,
  createBlock,
  edgeId,
  isBoundaryBlockKind,
  setBlockParams,
  validateGraph,
  WorkflowGraph,
  type PaletteBlockKind,
  type WorkflowTemplate,
} from "@reqflow/core";
import { z } from "zod";

export const WorkflowTemplateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  graph: WorkflowGraph,
});

function feedbackSetup(prioritized: boolean): WorkflowTemplate {
  const raw = createBlock("raw", {
    id: "feedback",
    label: "Customer feedback",
    position: { x: 0, y: 150 },
  });
  const car = createBlock("add_to_car", {
    id: "car",
    label: "Proposed car requirements",
    position: { x: prioritized ? 1020 : 680, y: 150 },
  });
  const rankings = prioritized ? ["Must have", "Should have", "Could have"] : ["Feedback"];
  const reviews = rankings.map((ranking, i) => {
    const review = createBlock("hil", {
      id: `review-${i}`,
      label: `PM review: ${ranking.toLowerCase()}`,
      position: { x: prioritized ? 680 : 340, y: i * 180 },
    });
    review.params = {
      ...review.params,
      reviewer: "pm",
      approvals: 1,
      instructions:
        "Check the source records, customer relevance and conflicting evidence before continuing. Continuing this flow does not approve its drafted requirements.",
    };
    return review;
  });
  const splitter = createBlock("ai_splitter", {
    id: "rank",
    label: "Prioritize customer signals",
    position: { x: 340, y: 150 },
  });
  let graph: WorkflowGraph = {
    blocks: [raw, ...(prioritized ? [splitter] : []), ...reviews, car],
    edges: [],
  };
  if (prioritized)
    graph = setBlockParams(graph, splitter.id, {
      ...splitter.params,
      splitBy: "priority",
      branches: ["Must have", "Should have", "Could have"],
    }).graph;
  if (prioritized)
    graph = connect(graph, {
      source: raw.id,
      sourcePort: "out",
      target: splitter.id,
      targetPort: "in",
    });
  reviews.forEach((review, i) => {
    graph = connect(graph, {
      source: prioritized ? splitter.id : raw.id,
      sourcePort: prioritized ? `out-${i}` : "out",
      target: review.id,
      targetPort: "in",
    });
    // Unranked feedback starts conservatively as "Should have" until the PM changes its routing.
    graph = connect(graph, {
      source: review.id,
      sourcePort: "out",
      target: car.id,
      targetPort: `in-${prioritized ? i : 1}`,
    });
  });
  return {
    name: prioritized ? "Prioritized feedback" : "Feedback to requirements",
    description: prioritized
      ? "Import feedback, rank customer signals into Must / Should / Could, review each nonempty branch, and draft proposed car requirements. Requires an AI provider or the offline mock in Settings."
      : "Import customer feedback, review its source records with the PM, and draft proposed car requirements. Proposals start as Should have; change the ranking input to adjust this.",
    graph,
  };
}

export const FEEDBACK_TEMPLATES: readonly WorkflowTemplate[] = [
  feedbackSetup(false),
  feedbackSetup(true),
];

/** Fresh parent and boundary ids keep nested wiring intact when core syncs a block's ports. */
export function instantiateTemplate(
  input: WorkflowTemplate,
  mintId: (kind: PaletteBlockKind) => string,
): WorkflowGraph {
  const template = WorkflowTemplateSchema.parse(input);
  const validate = (graph: WorkflowGraph) => {
    const issues = validateGraph(graph);
    if (issues.length)
      throw new Error(
        `Template "${template.name}": ${issues.map((issue) => issue.message).join("; ")}`,
      );
  };
  validate(template.graph);
  const clone = (graph: WorkflowGraph, parentId?: string): WorkflowGraph => {
    const ids = new Map(
      graph.blocks.map((block) => [
        block.id,
        isBoundaryBlockKind(block.kind)
          ? boundaryBlockId(parentId!, String(block.params.port))
          : mintId(block.kind),
      ]),
    );
    return {
      blocks: graph.blocks.map((block) => {
        const id = ids.get(block.id)!;
        return {
          ...block,
          id,
          params: structuredClone(block.params),
          position: { ...block.position },
          ...(block.inner ? { inner: clone(block.inner, id) } : {}),
        };
      }),
      edges: graph.edges.map((edge) => {
        const connection = {
          source: ids.get(edge.source)!,
          sourcePort: edge.sourcePort,
          target: ids.get(edge.target)!,
          targetPort: edge.targetPort,
        };
        return { ...connection, id: edgeId(connection) };
      }),
    };
  };
  const graph = clone(template.graph);
  validate(graph);
  return graph;
}
