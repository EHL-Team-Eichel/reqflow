import type { ReactNode } from "react";

export function SettingRow(props: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between border-b border-line last:border-b-0">
      <div className="flex-1 pr-6">
        <div className="text-sm font-medium text-ink">{props.label}</div>
        {props.description && <div className="mt-1 text-sm text-muted">{props.description}</div>}
      </div>
      <div className="flex w-full flex-col gap-1.5 sm:w-72 shrink-0">
        {props.children}
        {props.error && (
          <p role="alert" className="text-xs text-danger">
            {props.error}
          </p>
        )}
      </div>
    </div>
  );
}
