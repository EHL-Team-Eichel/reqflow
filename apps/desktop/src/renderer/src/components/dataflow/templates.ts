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
  const rankings = prioritized ? ["1. Priority", "2. Priority", "3. Priority"] : ["Feedback"];
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
      branches: ["1. Priority", "2. Priority", "3. Priority"],
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
    // Unranked feedback starts conservatively on "2. Priority" until the PM changes its routing.
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
      ? "Import feedback, rank customer signals into Must / Should / Could (1., 2. and 3. Priority), review each nonempty branch, and draft proposed car requirements. Requires an AI provider or the offline mock in Settings."
      : "Import customer feedback, review its source records with the PM, and draft proposed car requirements. Feedback arrives on 2. Priority; connect it to another priority input to change this.",
    graph,
  };
}

export const FEEDBACK_TEMPLATES: readonly WorkflowTemplate[] = [
  feedbackSetup(false),
  feedbackSetup(true),
];

/** Two feedback sources side by side in one Analytics block: counts by rules, no AI, no run needed. */
function analyticsSetup(): WorkflowTemplate {
  const sources = ["Feedback A", "Feedback B"].map((label, i) => {
    const raw = createBlock("raw", {
      id: `source-${i}`,
      label,
      position: { x: 0, y: i * 200 },
    });
    // Comparing by country needs every market, not only the one selected in Settings.
    raw.params = { ...raw.params, dataset: "customer_feedback", marketFilter: "all" };
    return raw;
  });
  const analytics = createBlock("analytics", {
    id: "analytics",
    label: "Feedback analytics",
    position: { x: 380, y: 80 },
  });
  let graph: WorkflowGraph = { blocks: [...sources, analytics], edges: [] };
  graph = setBlockParams(graph, analytics.id, {
    ...analytics.params,
    inputs: sources.map((s) => s.label),
  }).graph;
  sources.forEach((source, i) => {
    graph = connect(graph, {
      source: source.id,
      sourcePort: "out",
      target: analytics.id,
      targetPort: `in-${i}`,
    });
  });
  return {
    name: "Compare feedback sources",
    description:
      "Choose two feedback files and open the Analytics block: who says what by country, over time and by topic, and how the two sources differ. Rules only, no AI provider needed.",
    graph,
  };
}

export const ANALYTICS_TEMPLATES: readonly WorkflowTemplate[] = [analyticsSetup()];

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
