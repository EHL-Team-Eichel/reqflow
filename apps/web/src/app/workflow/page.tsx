import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export default function WorkflowPage() {
  return (
    <PagePlaceholder
      title="Workflow"
      purpose="n8n-style canvas: wire data sources, AI steps and review gates into a pipeline, run it, and inspect every node's output."
      owner="WS2"
      builds={[
        "React Flow canvas (@xyflow/react) with a palette from GET /api/nodes, grouped by category",
        "Config side panel generated from each node's configJsonSchema; file upload for BMW datasets",
        "Save / load workflows; 'New from template' (BMW default pipeline)",
        "Run button, live per-node status + counts + logs (poll GET /api/runs/:id)",
        "Click a node → inspect its output data; 'Waiting for PM review' banner linking to /requirements",
      ]}
    />
  );
}
