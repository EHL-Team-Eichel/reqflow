import type { ComponentType, SVGProps } from "react";
import { NavLink } from "react-router";
import { CarIcon, FlowIcon, SlidersIcon } from "@/components/ui/icons";
import { MStripe } from "@/components/ui/MStripe";
import { cx } from "@/lib/cx";

export const TABS: readonly {
  to: string;
  label: string;
  hint: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { to: "/dataflow", label: "Data Flow", hint: "Build the flow from blocks", Icon: FlowIcon },
  { to: "/car", label: "Car", hint: "Requirements for the next car", Icon: CarIcon },
  { to: "/settings", label: "Settings", hint: "App, parameters, team", Icon: SlidersIcon },
];

const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/** The tab bar from the app sketch: Data Flow · Car · Settings. */
export function BottomNav() {
  return (
    <nav aria-label="Pages" className="grid h-16 shrink-0 grid-cols-3 gap-2">
      {TABS.map(({ to, label, hint, Icon }, i) => (
        <NavLink
          key={to}
          to={to}
          data-testid={`tab-${to.slice(1)}`}
          className={({ isActive }) =>
            cx(
              "group relative flex items-center gap-3 overflow-hidden rounded-xl border bg-panel px-5 transition",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              isActive
                ? "border-line-strong text-ink"
                : "border-line text-muted hover:border-line-strong hover:text-ink",
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && <MStripe className="absolute inset-x-0 top-0 rounded-none" />}
              <Icon className={cx("size-5 shrink-0", isActive && "text-brand")} />
              <span className="min-w-0">
                <span className="block text-[15px] font-medium">{label}</span>
                <span
                  className={cx(
                    "block truncate text-xs",
                    isActive ? "text-muted" : "text-muted/80",
                  )}
                >
                  {hint}
                </span>
              </span>
              <kbd className="ml-auto hidden font-sans text-xs text-muted lg:block">
                {MOD}
                {i + 1}
              </kbd>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
