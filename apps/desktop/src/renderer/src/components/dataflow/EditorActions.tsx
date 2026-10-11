import { useReactFlow } from "@xyflow/react";
import { isBoundaryBlockKind } from "@reqflow/core";
import { Button } from "../ui/Button";
import { dataflowStore, selectWorkplace, useDataflow } from "./store";

export function EditorActions({
  problemCount,
  problemsOpen,
  onProblems,
}: {
  problemCount: number;
  problemsOpen: boolean;
  onProblems(): void;
}) {
  const graph = useDataflow(selectWorkplace);
  const selected = useDataflow((s) => s.selectedBlockIds);
  const past = useDataflow((s) => s.past);
  const future = useDataflow((s) => s.future);
  const clipboard = useDataflow((s) => s.clipboard);
  const { fitView } = useReactFlow();
  const hasSelection = graph.blocks.some(
    (block) => selected.includes(block.id) && !isBoundaryBlockKind(block.kind),
  );

  const tidy = () => {
    if (!dataflowStore.getState().tidyUp()) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void fitView({ maxZoom: 1, padding: 0.3, duration: 200 })),
    );
  };

  return (
    <div
      role="group"
      aria-label="Graph editing actions"
      className="flex flex-wrap items-center gap-1"
    >
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-undo"
        disabled={!past.length}
        title="Undo graph edit (Ctrl/Cmd Z)"
        onClick={() => dataflowStore.getState().undo()}
      >
        Undo
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-redo"
        disabled={!future.length}
        title="Redo graph edit (Ctrl/Cmd Shift Z)"
        onClick={() => dataflowStore.getState().redo()}
      >
        Redo
      </Button>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-copy"
        disabled={!hasSelection}
        title="Copy selected blocks (Ctrl/Cmd C)"
        onClick={() => dataflowStore.getState().copySelection()}
      >
        Copy
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-paste"
        disabled={!clipboard?.blocks.length}
        title="Paste copied blocks (Ctrl/Cmd V)"
        onClick={() => dataflowStore.getState().pasteSelection()}
      >
        Paste
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-duplicate"
        disabled={!hasSelection}
        title="Duplicate selected blocks (Ctrl/Cmd D)"
        onClick={() => dataflowStore.getState().duplicateSelection()}
      >
        Duplicate
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="editor-tidy"
        disabled={!graph.blocks.length}
        title="Arrange this workplace without changing its connections"
        onClick={tidy}
      >
        Tidy up
      </Button>
      <Button
        size="sm"
        data-testid="editor-problems"
        aria-expanded={problemsOpen}
        onClick={onProblems}
        className={problemCount ? "text-warn" : "text-muted"}
      >
        Problems{problemCount ? ` (${problemCount})` : ""}
      </Button>
    </div>
  );
}
