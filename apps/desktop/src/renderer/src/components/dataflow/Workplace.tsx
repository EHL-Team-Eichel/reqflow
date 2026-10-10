import { useMemo, type DragEvent, type RefObject } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type OnBeforeDelete,
} from "@xyflow/react";
import { breadcrumbOf, useDataflow, selectWorkplace, dataflowStore } from "./store";
import { confirmDelete } from "./confirm-delete";
import { toFlowNodes, toFlowEdges, type BlockFlowNode } from "./flow";
import { BlockNode } from "./BlockNode";
import { BoundaryNode } from "./BoundaryNode";
import { Inspector } from "./Inspector";
import { NoticeToast } from "./NoticeToast";
import { isBoundaryBlockKind, isPaletteBlockKind } from "@reqflow/core";
import { useSettings } from "@/lib/settings";
import { useResolvedTheme } from "@/lib/theme";

const nodeTypes = { block: BlockNode, boundary: BoundaryNode };

export function Workplace({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const { screenToFlowPosition } = useReactFlow();
  const theme = useResolvedTheme();
  const settings = useSettings((s) => s.settings);

  const root = useDataflow((s) => s.root);
  const graph = useDataflow(selectWorkplace);
  const selectedBlockIds = useDataflow((s) => s.selectedBlockIds);
  const selectedEdgeIds = useDataflow((s) => s.selectedEdgeIds);
  const measured = useDataflow((s) => s.measured);
  const path = useDataflow((s) => s.path);

  const nodes = useMemo(
    () => toFlowNodes(graph, selectedBlockIds, measured),
    [graph, selectedBlockIds, measured],
  );
  const edges = useMemo(() => toFlowEdges(graph, selectedEdgeIds), [graph, selectedEdgeIds]);

  const onBeforeDelete: OnBeforeDelete<BlockFlowNode> = async ({ nodes: deleted }) => {
    if (!settings.app.confirmBeforeDelete) return true;
    return confirmDelete(deleted.filter((n) => n.type === "block").map((n) => n.data.block));
  };

  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("application/reqflow-block")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData("application/reqflow-block");
    if (!isPaletteBlockKind(kind)) return;

    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    dataflowStore.getState().addBlock(kind, { x: pos.x - 112, y: pos.y - 40 });
  };

  const isTopLevel = path.length === 0;
  const showEmptyState = !graph.blocks.some((b) => !isBoundaryBlockKind(b.kind));
  const parentLabel = useMemo(() => breadcrumbOf(root, path).at(-1)?.label ?? "", [root, path]);

  return (
    <div ref={canvasRef} className="relative h-full w-full">
      <ReactFlow
        key={path.join("/") || "root"}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => dataflowStore.getState().applyNodeChanges(changes)}
        onEdgesChange={(changes) => dataflowStore.getState().applyEdgeChanges(changes)}
        onConnect={(c) => {
          dataflowStore.getState().connect(c);
        }}
        isValidConnection={(c) => dataflowStore.getState().checkConnection(c).ok}
        deleteKeyCode={["Backspace", "Delete"]}
        onBeforeDelete={onBeforeDelete}
        snapToGrid={settings.app.snapToGrid}
        snapGrid={[16, 16]}
        colorMode={theme}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onNodeDoubleClick={(_, node) => {
          if (node.type === "block") {
            const blockNode = node as BlockFlowNode;
            if (blockNode.data.block.kind === "hil") {
              dataflowStore.getState().openReport(node.id);
            } else if (blockNode.data.spec?.hasInnerWorkplace) {
              dataflowStore.getState().openInner(node.id);
            }
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        {settings.app.showMinimap && <MiniMap pannable zoomable />}
      </ReactFlow>

      {showEmptyState && (
        <div
          data-testid="workplace-empty"
          className={
            isTopLevel
              ? "pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted"
              : "pointer-events-none absolute inset-x-0 top-6 flex flex-col items-center gap-1 text-center text-muted"
          }
        >
          {isTopLevel ? (
            <>
              <p className="text-base font-medium">Drag building blocks here</p>
              <p className="text-sm">Connect an output (right) to an input (left).</p>
            </>
          ) : (
            <>
              <p className="text-base font-medium">
                This is the inside of &ldquo;{parentLabel}&rdquo;.
              </p>
              <p className="text-sm">
                Build its flow from blocks between the dashed input and output.
              </p>
            </>
          )}
        </div>
      )}

      <Inspector />
      <NoticeToast />
    </div>
  );
}
