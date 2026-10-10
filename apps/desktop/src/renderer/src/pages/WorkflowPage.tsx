import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export function WorkflowPage() {
  return (
    <PagePlaceholder
      title="Workflow"
      purpose="n8n-style canvas: wire data sources, AI steps and review gates into a pipeline, run it, and inspect every node's output."
      owner="WS2"
      builds={[
        "React Flow canvas (@xyflow/react) with a palette from api.nodes.catalog(), grouped by category",
        "Config side panel generated from each node's configJsonSchema; BMW datasets via api.files.import() (native file dialog)",
        "Save / load workflows (api.workflows.*); 'New from template' (api.templates.list())",
        "Run button; live per-node status, counts and logs via api.runs.onUpdate()",
        "Click a node → inspect api.runs.nodeOutput(); 'Waiting for PM review' banner linking to Requirements",
      ]}
    />
  );
}
