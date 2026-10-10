import { cx } from "@/lib/cx";

/**
 * The BMW M stripe: light blue, dark blue, red. `bar` is a thin full-width line (active tab),
 * `badge` the three slanted strokes (next to the car name).
 */
export function MStripe({
  variant = "bar",
  className,
}: {
  variant?: "bar" | "badge";
  className?: string;
}) {
  const colors = ["bg-m-light", "bg-m-dark", "bg-m-red"];
  return variant === "bar" ? (
    <span aria-hidden="true" className={cx("flex h-[3px] overflow-hidden rounded-full", className)}>
      {colors.map((c) => (
        <span key={c} className={cx("flex-1", c)} />
      ))}
    </span>
  ) : (
    <span aria-hidden="true" className={cx("inline-flex h-4 gap-[3px]", className)}>
      {colors.map((c) => (
        <span key={c} className={cx("w-[5px] -skew-x-[20deg]", c)} />
      ))}
    </span>
  );
}
