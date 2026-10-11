import { useMemo } from "react";
import { Button } from "../ui/Button";
import { dataflowStore, useDataflow } from "./store";
import { workflowProblems } from "./problems";

export function ProblemsPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const root = useDataflow((state) => state.root);
  const problems = useMemo(() => workflowProblems(root), [root]);
  if (!open) return null;
  return (
    <aside
      data-testid="workflow-problems"
      aria-label="Workflow problems"
      className="fixed top-36 bottom-24 left-4 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-line bg-panel shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-line p-3">
        <h2 className="text-sm font-semibold">Problems ({problems.length})</h2>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!problems.length && (
          <p role="status" className="text-sm text-muted">
            No graph or input-configuration problems found. Provider access is checked only when you
            explicitly run the flow.
          </p>
        )}
        <div className="space-y-2">
          {problems.map((problem) => (
            <button
              key={problem.id}
              type="button"
              data-testid="workflow-problem"
              className="block w-full rounded-lg border border-line bg-panel-2 p-3 text-left text-xs text-warn hover:border-brand"
              onClick={() => {
                const graph = problem.path.reduce(
                  (current, id) => current.blocks.find((block) => block.id === id)!.inner!,
                  root,
                );
                const blockId =
                  problem.blockId ?? graph.edges.find((edge) => edge.id === problem.edgeId)?.target;
                if (blockId) dataflowStore.getState().revealBlock(problem.path, blockId);
                else dataflowStore.getState().goTo(0);
                onClose();
              }}
            >
              <span className="block font-medium">
                {problem.path.length ? "Inner workplace" : "Main workplace"}
              </span>
              <span>{problem.message}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
