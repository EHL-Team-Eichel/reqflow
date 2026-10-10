import { useId, type ReactNode } from "react";

/**
 * Label + control + help/error, stacked. The render prop receives the id to put on the control,
 * so the label is linked to it.
 */
export function Field(props: {
  label: string;
  help?: string;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {props.label}
      </label>
      {props.children(id)}
      {props.error ? (
        <p role="alert" className="text-xs text-danger">
          {props.error}
        </p>
      ) : (
        props.help && <p className="text-xs text-muted">{props.help}</p>
      )}
    </div>
  );
}
