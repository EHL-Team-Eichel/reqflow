import {
  connect,
  createBlock,
  emptyGraph,
  setBlockParams,
  type PaletteBlockKind,
  type WorkflowGraph,
  type WorkflowTemplate,
} from "@reqflow/core";

const COL = 320; // horizontal spacing on the workplace
const ROW = 150;

function build(): WorkflowGraph {
  let g = emptyGraph();
  const add = (kind: PaletteBlockKind, id: string, label: string, col: number, row: number) => {
    g = {
      ...g,
      blocks: [
        ...g.blocks,
        createBlock(kind, { id, label, position: { x: col * COL, y: row * ROW } }),
      ],
    };
  };
  const params = (id: string, patch: Record<string, unknown>) => {
    const block = g.blocks.find((b) => b.id === id)!;
    g = setBlockParams(g, id, { ...block.params, ...patch }).graph;
  };
  const wire = (source: string, sourcePort: string, target: string, targetPort: string) => {
    g = connect(g, { source, sourcePort, target, targetPort });
  };

  add("raw", "feedback", "Customer feedback", 0, 0);
  add("raw", "study", "Customer study", 0, 1);
  add("raw", "equipment", "Equipment data", 0, 2);
  add("raw", "sales", "Sales volumes", 0, 3);
  add("research", "web", "Web research", 0, 4);
  params("study", { dataset: "customer_study" });
  params("equipment", { dataset: "equipment_data" });
  params("sales", { dataset: "sales_volume" });
  add("ai_filter", "scope", "Customer-facing only", 1, 2);
  params("scope", {
    criterion: "are customer-facing, not regulation, engineering specs or pricing.",
  });
  add("ai_splitter", "rank", "Rank by priority", 2, 2);
  add("hil", "review-must", "PM review: must", 3, 1);
  add("hil", "review-should", "PM review: should", 3, 2);
  add("add_to_car", "car", "Add to Car", 4, 2);
  params("car", { contexts: ["sales_volumes"] });

  for (const src of ["feedback", "study", "equipment", "web"]) wire(src, "out", "scope", "in");
  wire("sales", "out", "car", "ctx-0"); // background for the agents, not requirements themselves
  wire("scope", "out", "rank", "in");
  wire("rank", "out-0", "review-must", "in");
  wire("rank", "out-1", "review-should", "in");
  wire("review-must", "out", "car", "in-0");
  wire("review-should", "out", "car", "in-1");
  wire("rank", "out-2", "car", "in-2"); // could-haves go straight to the car, unreviewed
  return g;
}

/**
 * The end-to-end flow we demo, laid out like the BMW process slide: data → filter → rank →
 * human review → car. Built with the core graph operations, so it is valid by construction.
 */
export const BMW_DEFAULT_TEMPLATE: WorkflowTemplate = {
  name: "BMW successor requirements",
  description:
    "BMW data and web research, filtered to customer-facing items, ranked by priority, reviewed by the PM and added to the car.",
  graph: build(),
};
