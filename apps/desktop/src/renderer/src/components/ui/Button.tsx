import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

const VARIANTS = {
  primary: "bg-brand-fill text-white hover:brightness-110 border-transparent",
  secondary: "bg-panel text-ink border-line hover:bg-panel-2",
  ghost: "bg-transparent text-ink border-transparent hover:bg-panel-2",
  danger: "bg-panel text-danger border-line hover:bg-danger-soft",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
