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
