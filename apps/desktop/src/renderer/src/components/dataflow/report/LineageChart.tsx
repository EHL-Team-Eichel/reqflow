import { useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Edge,
  type Node,
} from "@xyflow/react";
import { type Lineage, type WorkflowGraph, blockPorts } from "@reqflow/core";
import { StepNode, type StepNodeData } from "./StepNode";
import { layoutLineage } from "./layout";
import { dataflowStore, breadcrumbOf } from "../store";
import { useResolvedTheme } from "@/lib/theme";

interface Props {
  lineage: Lineage;
  selectedStepId: string;
  onSelectStep: (id: string) => void;
  root: WorkflowGraph;
}

const nodeTypes = { step: StepNode };

export function LineageChart({ lineage, selectedStepId, onSelectStep, root }: Props) {
  const theme = useResolvedTheme();

  const { nodes, edges } = useMemo(() => {
    const layout = layoutLineage(lineage);
    const nodes: Node<StepNodeData>[] = lineage.steps.map((step) => {
      let workplaceLabel: string | undefined;
      if (step.path.length > 0) {
        workplaceLabel = breadcrumbOf(root, step.path).at(-1)?.label;
      }

      return {
        id: step.block.id,
        type: "step",
        position: layout[step.block.id] || { x: 0, y: 0 },

        data: {
          step,
          isTarget: step.block.id === lineage.targetId,
          isSelected: step.block.id === selectedStepId,
          workplaceLabel,
          onShowData: onSelectStep,
          onReveal: (s) => dataflowStore.getState().revealBlock(s.path, s.block.id),
        },
      };
    });

    const edges: Edge[] = lineage.links.map((link) => {
      const sourceStep = lineage.steps.find((s) => s.block.id === link.source);
      const targetStep = lineage.steps.find((s) => s.block.id === link.target);

      let label: string | undefined;
      if (sourceStep) {
        const ports = blockPorts(sourceStep.block);
        if (ports.outputs.length > 1) {
          label = link.sourceLabel;
        }
      }
      if (!label && targetStep) {
        const ports = blockPorts(targetStep.block);
        if (ports.inputs.length > 1) {
          label = link.targetLabel;
        }
      }

      return {
        id: link.id,
        source: link.source,
        target: link.target,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        label,
        labelStyle: { fill: "var(--color-muted)", fontWeight: 500 },
        labelBgStyle: { fill: "var(--color-panel)" },
      };
    });

    return { nodes, edges };
  }, [lineage, selectedStepId, onSelectStep, root]);

  return (
    <div className="h-full w-full bg-panel">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => onSelectStep(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          colorMode={theme}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
