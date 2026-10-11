import type { PaletteBlockKind, BoundaryBlockKind } from "@reqflow/core";
import { CarIcon } from "@/components/ui/icons";

export function BlockIcon({
  kind,
  className,
}: {
  kind: PaletteBlockKind | BoundaryBlockKind;
  className?: string;
}) {
  if (kind === "add_to_car") {
    return <CarIcon className={className} />;
  }

  const svgProps = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className,
    "aria-hidden": true,
  } as const;

  switch (kind) {
    case "custom":
      return (
        <svg {...svgProps}>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <path d="M14 17h6M17 14v6" />
        </svg>
      );
    case "raw":
      return (
        <svg {...svgProps}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case "research":
      return (
        <svg {...svgProps}>
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
          <path d="M3.5 11h15" />
          <path d="M11 3.5a15.3 15.3 0 010 15a15.3 15.3 0 010-15z" />
        </svg>
      );
    case "ai_filter":
      return (
        <svg {...svgProps}>
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      );
    case "ai_splitter":
      return (
        <svg {...svgProps}>
          <path d="M3 12h5M8 12c4 0 4-6 8-6h4M8 12h12M8 12c4 0 4 6 8 6h4" />
          <path d="m18 4 2 2-2 2M18 10l2 2-2 2M18 16l2 2-2 2" />
        </svg>
      );
    case "hil":
      return (
        <svg {...svgProps}>
          <path d="M2 12h8 M14 12h8 M10 5v14 M14 5v14" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...svgProps}>
          <path d="M3 3v18h18" />
          <path d="M7 16v-3M11 16V9M15 16v-5M19 16V6" />
        </svg>
      );
    case "block_input":
      return (
        <svg {...svgProps}>
          <path d="M14 8l-4 4 4 4" />
          <path d="M21 12H10" />
          <path d="M6 4v16" />
        </svg>
      );
    case "block_output":
      return (
        <svg {...svgProps}>
          <path d="M10 8l4 4-4 4" />
          <path d="M3 12h11" />
          <path d="M18 4v16" />
        </svg>
      );
    default:
      return null;
  }
}
