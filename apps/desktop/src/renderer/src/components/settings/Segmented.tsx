import { cx } from "../../lib/cx";

export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  testIdPrefix?: string;
}) {
  return (
    <div role="radiogroup" className="inline-flex h-9 rounded-lg bg-panel-2 p-1 border border-line">
      {props.options.map((opt) => {
        const active = opt.value === props.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={props.testIdPrefix ? props.testIdPrefix + opt.value : undefined}
            onClick={() => props.onChange(opt.value)}
            className={cx(
              "flex-1 rounded-md px-2.5 text-sm font-medium whitespace-nowrap transition",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              active
                ? "bg-panel text-ink shadow-sm ring-1 ring-line"
                : "text-muted hover:text-ink hover:bg-line",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
