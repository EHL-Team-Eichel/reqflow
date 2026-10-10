import { cx } from "@/lib/cx";
import type { ReactNode } from "react";

export interface NavItem {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
}

export function SettingsNav(props: {
  items: readonly NavItem[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 border-r border-line p-3">
      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`settings-section-${item.id}`}
            onClick={() => props.onChange(item.id)}
            className={cx(
              "flex flex-col items-start rounded-lg p-3 text-left transition",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              active ? "bg-brand-soft text-brand" : "text-ink hover:bg-panel-2",
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              {item.icon}
              {item.label}
            </div>
            <div className={cx("mt-1 text-xs", active ? "text-brand/80" : "text-muted")}>
              {item.hint}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
