import type { SVGProps } from "react";

/** Line icons (24×24, stroke = currentColor). Size them with className, e.g. "size-5". */
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, strokeWidth = 1.6, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Side view of a sedan. */
export function CarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 16H3.5a1 1 0 0 1-1-1v-2.3a1 1 0 0 1 .76-.97L6 11l2.2-3.1A2 2 0 0 1 9.83 7h4.9a2 2 0 0 1 1.5.68L19 11l1.74.44a1 1 0 0 1 .76.97V15a1 1 0 0 1-1 1H19" />
      <path d="M9 16h6M6 11h13M12.5 7v4" />
      <circle cx="7" cy="16" r="2" />
      <circle cx="17" cy="16" r="2" />
    </Icon>
  );
}

/** Three connected blocks. */
export function FlowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4" width="6" height="5" rx="1.5" />
      <rect x="15.5" y="4" width="6" height="5" rx="1.5" />
      <rect x="15.5" y="15" width="6" height="5" rx="1.5" />
      <path d="M8.5 6.5h7M8.5 6.5c3.5 0 3.5 11 7 11" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Icon strokeWidth={2} {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

/** Two diagonal arrows: "open / enter". */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon strokeWidth={2} {...props}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Icon>
  );
}

export function TableIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </Icon>
  );
}

export function ReportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2h6a2 2 0 0 1 2 2v2h-10v-2a2 2 0 0 1 2-2z" />
      <path d="M17 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h2" />
      <path d="M8 14l3-3 2 2 4-4" />
      <path d="M17 9v0" />
    </Icon>
  );
}

/** A lightbulb: the agents' thought process. */
export function ThoughtIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
    </Icon>
  );
}
export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 18l6-6-6-6" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </Icon>
  );
}

/** Bar chart on axes: the analytics view. */
export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 16v-3M11 16V9M15 16v-5M19 16V6" />
    </Icon>
  );
}

/** Four corner brackets pointing out: enter full screen. */
export function MaximizeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

/** Four corner brackets pointing in: leave full screen. */
export function MinimizeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" />
    </Icon>
  );
}

/** Plus sign: add an entry. */
export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}
