import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** Glyph and colour for each tone. The glyph carries the meaning; the colour only repeats it. */
const TONE = {
  up: { glyph: "▲", className: "text-ok" },
  down: { glyph: "▼", className: "text-danger" },
  flat: { glyph: "●", className: "text-muted" },
} as const;

/**
 * A headline number with its label (a hero figure, not a chart). `delta` describes the change
 * against a named period, and its tone says whether that change is favourable (up, green), not
 * favourable (down, red) or unchanged (flat, grey). The text should state the sign itself.
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: { text: string; tone: "up" | "down" | "flat" };
  testId?: string;
}) {
  const tone = delta ? TONE[delta.tone] : undefined;
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-panel p-4"
    >
      <p className="truncate text-xs tracking-wide text-muted uppercase" title={label}>
        {label}
      </p>
      {/* Proportional figures: tabular digits are for aligned columns, not for a hero number. */}
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {delta && tone && (
        <p className={cx("mt-1 text-xs font-medium", tone.className)}>
          <span aria-hidden="true">{tone.glyph} </span>
          {delta.text}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/**
 * Lays StatTiles out by the width of their card: two columns when narrow, three in a medium card,
 * six when wide.
 */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-3 @5xl:grid-cols-6">{children}</div>
    </div>
  );
}
