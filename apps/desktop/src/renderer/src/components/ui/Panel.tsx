import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** The rounded card from the app sketch: a title row and a body that fills the rest. */
export function Panel(props: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={props.testId}
      className={cx(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel",
        props.className,
      )}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-3 px-5 pt-3 pb-2">
        <h2 className="min-w-0 truncate text-[15px] font-medium text-ink">{props.title}</h2>
        {props.actions && <div className="ml-auto flex items-center gap-2">{props.actions}</div>}
      </header>
      <div className={cx("min-h-0 flex-1", props.bodyClassName)}>{props.children}</div>
    </section>
  );
}
