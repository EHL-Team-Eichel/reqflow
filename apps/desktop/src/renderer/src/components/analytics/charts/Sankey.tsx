import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { formatNumber, formatPercent, truncate } from "./format";
import { ChartTooltip, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";
import {
  layoutSankey,
  stageX,
  type SankeyLink,
  type SankeyLinkInput,
  type SankeyNode,
  type SankeyNodeInput,
} from "./sankey-layout";

const NODE_W = 12;
const PAD = 10; // vertical gap between nodes in a column
const HEADER_H = 24; // stage headers above the diagram
const FOOT_H = 6;
const LABEL_MIN_H = 10; // shorter nodes get no label; the tooltip still works
const CHAR_PX = 6.5; // generous advance of 11px text, for layout only

type Active =
  | { kind: "node"; id: string; hover: HoverState }
  | { kind: "link"; index: number; hover: HoverState };

/**
 * Flow of records through stages, left to right. Bands take their source's colour; hovering or
 * focusing a band or node highlights its flow and shows the numbers. Node labels sit beside the
 * node, with the value in muted text.
 */
export function Sankey({
  nodes,
  links,
  stageLabels,
  height = 360,
  valueFormat = formatNumber,
  ariaLabel,
  onSelectNode,
}: {
  nodes: SankeyNodeInput[];
  links: SankeyLinkInput[];
  stageLabels: string[];
  height?: number;
  valueFormat?: (v: number) => string;
  ariaLabel: string;
  onSelectNode?: (id: string) => void;
}): ReactElement | null {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<Active | null>(null);
  const layout = useMemo(
    () =>
      layoutSankey(nodes, links, {
        width,
        height: height - HEADER_H - FOOT_H,
        nodeWidth: NODE_W,
        nodePadding: PAD,
      }),
    [nodes, links, width, height],
  );
  if (layout.nodes.length === 0) return null;

  const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const maxStage = Math.max(...layout.nodes.map((node) => node.stage));
  const outTotal = new Map<string, number>();
  const inTotal = new Map<string, number>();
  for (const link of layout.links) {
    outTotal.set(link.source, (outTotal.get(link.source) ?? 0) + link.value);
    inTotal.set(link.target, (inTotal.get(link.target) ?? 0) + link.value);
  }

  // Room for a label: a column's labels share the gap with the neighbouring column's labels.
  const step = maxStage > 0 ? (width - NODE_W) / maxStage : width;
  const labelRoom = Math.max(60, maxStage > 0 ? (step - 24) / 2 - 4 : width - NODE_W - 22);

  const nodeTip = (node: SankeyNode): ReactNode => {
    const incoming = inTotal.get(node.id) ?? 0;
    const outgoing = outTotal.get(node.id) ?? 0;
    return (
      <div>
        <div className="mb-1 font-medium text-ink">{node.label}</div>
        {incoming > 0 && <TooltipRow label="Incoming" value={valueFormat(incoming)} />}
        {outgoing > 0 && <TooltipRow label="Outgoing" value={valueFormat(outgoing)} />}
      </div>
    );
  };

  const linkTip = (link: SankeyLink, source: SankeyNode, target: SankeyNode): ReactNode => {
    const total = outTotal.get(source.id) ?? 0;
    const share = total > 0 ? link.value / total : 0;
    return (
      <div>
        {source.label} → {target.label}:{" "}
        <span className="font-semibold tabular-nums text-ink">{valueFormat(link.value)}</span>{" "}
        <span className="text-muted">
          ({formatPercent(share)} of {source.label})
        </span>
      </div>
    );
  };

  const nodeActive = (node: SankeyNode): Active => ({
    kind: "node",
    id: node.id,
    hover: { x: (node.x0 + node.x1) / 2, y: node.y0 + HEADER_H, content: nodeTip(node) },
  });

  const linkActive = (
    index: number,
    link: SankeyLink,
    source: SankeyNode,
    target: SankeyNode,
  ): Active => ({
    kind: "link",
    index,
    hover: {
      x: (source.x1 + target.x0) / 2,
      y: (link.y0 + link.width / 2 + link.y1 + link.width / 2) / 2 + HEADER_H,
      content: linkTip(link, source, target),
    },
  });

  const isLitLink = (link: SankeyLink, index: number): boolean => {
    if (active === null) return false;
    if (active.kind === "link") return active.index === index;
    return link.source === active.id || link.target === active.id;
  };

  const stages = Array.from({ length: maxStage + 1 }, (_, s) => s);

  return (
    <div ref={ref} className="relative min-w-0">
      <svg
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block"
      >
        {stages.map((s) => {
          const label = stageLabels[s];
          if (!label) return null;
          const last = maxStage > 0 && s === maxStage;
          const x0 = stageX(s, maxStage, width, NODE_W);
          return (
            <text
              key={s}
              x={last ? x0 + NODE_W : x0}
              y={HEADER_H - 8}
              textAnchor={last ? "end" : "start"}
              fontSize={11}
              fontWeight={600}
              className="uppercase tracking-wide"
              style={{ fill: "var(--color-muted)" }}
            >
              {label}
            </text>
          );
        })}

        <g transform={`translate(0 ${HEADER_H})`}>
          {layout.links.map((link, i) => {
            const source = byId.get(link.source);
            const target = byId.get(link.target);
            if (!source || !target) return null;
            const show = () => setActive(linkActive(i, link, source, target));
            return (
              <path
                key={`${link.source}>${link.target}>${i}`}
                d={link.path}
                fillOpacity={active === null ? 0.35 : isLitLink(link, i) ? 0.55 : 0.12}
                style={{ fill: source.color }}
                tabIndex={0}
                role="img"
                aria-label={`${source.label} → ${target.label}: ${valueFormat(link.value)}`}
                onPointerEnter={show}
                onPointerLeave={() => setActive(null)}
                onFocus={show}
                onBlur={() => setActive(null)}
              />
            );
          })}

          {layout.nodes.map((node) => {
            const h = node.y1 - node.y0;
            const focused = active?.kind === "node" && active.id === node.id;
            const onLeft = maxStage > 0 && node.stage === maxStage;
            const valueText = valueFormat(node.value);
            const chars = Math.max(
              4,
              Math.floor((labelRoom - (valueText.length + 1) * CHAR_PX) / CHAR_PX),
            );
            const show = () => setActive(nodeActive(node));
            return (
              <g key={node.id}>
                <rect
                  x={node.x0}
                  y={node.y0}
                  width={NODE_W}
                  height={h}
                  rx={2}
                  style={{ fill: node.color }}
                  pointerEvents="none"
                />
                {focused && (
                  <rect
                    x={node.x0 - 3}
                    y={node.y0 - 3}
                    width={NODE_W + 6}
                    height={h + 6}
                    rx={4}
                    fill="none"
                    strokeWidth={2}
                    style={{ stroke: "var(--color-ink)" }}
                    pointerEvents="none"
                  />
                )}
                <rect
                  x={node.x0 - 6}
                  y={node.y0 - 4}
                  width={NODE_W + 12}
                  height={h + 8}
                  fill="transparent"
                  tabIndex={0}
                  role={onSelectNode ? "button" : "img"}
                  aria-label={`${node.label}: ${valueText}`}
                  onPointerEnter={show}
                  onPointerLeave={() => setActive(null)}
                  onFocus={show}
                  onBlur={() => setActive(null)}
                  onClick={() => onSelectNode?.(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNode?.(node.id);
                    }
                  }}
                />
                {h >= LABEL_MIN_H && (
                  <text
                    x={onLeft ? node.x0 - 6 : node.x1 + 6}
                    y={(node.y0 + node.y1) / 2 + 4}
                    textAnchor={onLeft ? "end" : "start"}
                    fontSize={11}
                    pointerEvents="none"
                    paintOrder="stroke"
                    style={{
                      stroke: "var(--color-panel)",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    <tspan style={{ fill: "var(--color-ink)" }}>
                      {truncate(node.label, chars)}
                    </tspan>
                    <tspan dx={6} className="tabular-nums" style={{ fill: "var(--color-muted)" }}>
                      {valueText}
                    </tspan>
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <ChartTooltip hover={active?.hover ?? null} width={width} />
    </div>
  );
}
