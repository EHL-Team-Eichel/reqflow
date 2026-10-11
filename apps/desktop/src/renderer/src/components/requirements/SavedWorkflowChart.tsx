import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import { blockPorts, graphAt, type LineageStep } from "@reqflow/core";
import { StepNode, type StepNodeData } from "../dataflow/report/StepNode";
import { savedLineageLayout } from "./saved-chart-layout";
import { breadcrumbOf } from "../dataflow/store";
import { useResolvedTheme } from "@/lib/theme";
import type { RequirementOrigin } from "./requirement-origin";

const nodeTypes = { step: StepNode };

/** The HIL report's steps and layout, with Workplace opening the historical graph locally. */
export function SavedWorkflowChart({
  origin,
  selectedStep,
  workplace,
  onSelect,
  onWorkplace,
}: {
  origin: RequirementOrigin;
  selectedStep: LineageStep;
  workplace: string[] | null;
  onSelect: (step: LineageStep) => void;
  onWorkplace: (path: string[]) => void;
}) {
  const theme = useResolvedTheme();
  const { nodes, edges } = useMemo(() => {
    const graph = workplace ? graphAt(origin.run.graph, workplace) : null;
    const steps: LineageStep[] = graph
      ? graph.blocks.map((block) => ({ block, path: workplace!, distance: 0 }))
      : origin.lineage.steps;
    const layout = savedLineageLayout(origin.lineage);
    const nodes: Node<StepNodeData>[] = steps.map((step) => ({
      id: step.block.id,
      type: "step",
      position: graph ? step.block.position : layout[step.block.id]!,
      data: {
        step,
        isTarget: step.block.id === origin.step.block.id,
        isSelected: step.block.id === selectedStep.block.id,
        workplaceLabel: step.path.length
          ? breadcrumbOf(origin.run.graph, step.path).at(-1)?.label
          : undefined,
        onShowData: (id) => {
          const step = steps.find((step) => step.block.id === id);
          if (step) onSelect(step);
        },
        onReveal: (step) => {
          onSelect(step);
          onWorkplace(step.path);
        },
      },
    }));
    const links = graph
      ? graph.edges.map((edge) => {
          const source = graph.blocks.find((block) => block.id === edge.source)!;
          const target = graph.blocks.find((block) => block.id === edge.target)!;
          return {
            ...edge,
            sourceLabel: blockPorts(source).outputs.find((port) => port.id === edge.sourcePort)
              ?.label,
            targetLabel: blockPorts(target).inputs.find((port) => port.id === edge.targetPort)
              ?.label,
          };
        })
      : origin.lineage.links;
    const edges: Edge[] = links.map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      label: [link.sourceLabel, link.targetLabel].filter(Boolean).join(" → "),
      labelStyle: { fill: "var(--color-muted)", fontWeight: 500 },
      labelBgStyle: { fill: "var(--color-panel)" },
    }));
    return { nodes, edges };
  }, [origin, selectedStep, workplace, onSelect, onWorkplace]);

  return (
    <div
      className="h-full w-full bg-panel"
      data-testid="car-origin-chart"
      data-chart-mode={workplace ? "workflow" : "lineage"}
    >
      <ReactFlowProvider key={workplace?.join("/") ?? "lineage"}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => onSelect(node.data.step as LineageStep)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.1}
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
