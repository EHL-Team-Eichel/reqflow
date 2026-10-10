import { useEffect, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

/**
 * Shared form controls (used by the block inspector and the Settings page). All are controlled:
 * `value` in, `onChange(next)` out. Controls that can hold an invalid draft (numbers, lists) keep
 * it locally, show why it's invalid, and only call `onChange` with valid values.
 */

const INPUT_BASE =
  "rounded-lg border border-line bg-panel-2 px-3 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-60";
const INPUT = `w-full ${INPUT_BASE}`;

type Base<T> = { value: T; onChange: (value: T) => void; id?: string; disabled?: boolean };

export function TextInput({
  value,
  onChange,
  className,
  ...rest
}: Base<string> & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(INPUT, "h-9", className)}
    />
  );
}

/**
 * A text input whose value must pass a validator (e.g. a store update that returns an error).
 * It keeps the draft while the user types, so a field can be cleared and retyped, and words keep
 * their spaces even though the stored value is trimmed. On blur it shows the accepted value again.
 */
export function ValidatedTextInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string;
  /** Apply the text; return an error message to reject it. */
  onCommit: (text: string) => string | null;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // Follow outside changes (reset, rename elsewhere), but keep a draft that already means this value.
  useEffect(() => {
    setDraft((d) => (d.trim() === value ? d : value));
    setError(null);
  }, [value]);

  return (
    <div className="flex flex-col gap-1">
      <input
        {...rest}
        value={draft}
        aria-invalid={error ? true : undefined}
        onBlur={() => {
          setDraft(value);
          setError(null);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(onCommit(e.target.value));
        }}
        className={cx(INPUT, "h-9", error && "border-danger", className)}
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  value,
  onChange,
  className,
  rows = 3,
  ...rest
}: Base<string> & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  return (
    <textarea
      {...rest}
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(INPUT, "resize-y py-2 leading-relaxed", className)}
    />
  );
}

export function NumberInput(
  props: Base<number> & { min: number; max: number; step?: number; unit?: string },
) {
  const { value, onChange, min, max, step = 1, unit } = props;
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  // Follow outside changes, but keep a draft that already means this value ("0." while typing 0.5).
  useEffect(() => {
    setDraft((d) => (Number(d) === value && d.trim() !== "" ? d : String(value)));
    setError(null);
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n) || n < min || n > max) {
      setError(`Enter a number from ${min} to ${max}`);
      return;
    }
    setError(null);
    if (n !== value) onChange(n);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={props.id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          disabled={props.disabled}
          value={draft}
          aria-invalid={error ? true : undefined}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            if (error) {
              setDraft(String(value));
              setError(null);
            }
          }}
          className={cx(INPUT_BASE, "h-9 w-28 tabular-nums", error && "border-danger")}
        />
        {unit && <span className="text-xs text-muted">{unit}</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Select(
  props: Base<string> & { options: readonly { value: string; label: string }[] },
) {
  return (
    <select
      id={props.id}
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className={cx(INPUT, "h-9 cursor-pointer pr-8")}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle(props: Base<boolean> & { label?: string }) {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.value}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.value)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.value ? "bg-brand-fill" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "inline-block size-4 rounded-full bg-white shadow transition",
          props.value ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Slider(
  props: Base<number> & { min: number; max: number; step: number; unit?: string },
) {
  const decimals = (String(props.step).split(".")[1] ?? "").length;
  return (
    <div className="flex items-center gap-3">
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-brand"
      />
      <span className="w-12 text-right text-xs tabular-nums text-muted">
        {props.value.toFixed(decimals)}
        {props.unit ? ` ${props.unit}` : ""}
      </span>
    </div>
  );
}

/** Multi-select as toggle chips. */
export function ChipSelect(
  props: Base<readonly string[]> & { options: readonly { value: string; label: string }[] },
) {
  const selected = new Set(props.value);
  return (
    <div id={props.id} role="group" className="flex flex-wrap gap-1.5">
      {props.options.map((o) => {
        const on = selected.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={props.disabled}
            onClick={() =>
              props.onChange(
                on ? props.value.filter((v) => v !== o.value) : [...props.value, o.value],
              )
            }
            className={cx(
              "rounded-full border px-2.5 py-1 text-xs transition",
              on
                ? "border-brand bg-brand-soft text-brand"
                : "border-line bg-panel text-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An editable list of names (e.g. splitter branches). Emits only lists that are valid. With
 * `itemOptions`, every entry is picked from those options (e.g. Add to Car context modes).
 */
export function ListEditor(
  props: Base<readonly string[]> & {
    minItems: number;
    maxItems: number;
    itemPlaceholder?: string;
    itemOptions?: readonly { value: string; label: string }[];
  },
) {
  const { value, onChange, minItems, maxItems, itemOptions } = props;
  const [draft, setDraft] = useState<string[]>([...value]);
  const [error, setError] = useState<string | null>(null);
  // Follow outside changes, but keep the draft while it already means this value (trailing spaces).
  useEffect(() => {
    setDraft((d) =>
      d.length === value.length && d.every((item, i) => item.trim() === value[i]) ? d : [...value],
    );
    setError(null);
  }, [value]);

  const update = (next: string[]) => {
    setDraft(next);
    if (next.some((item) => item.trim() === "")) return setError("Entries can't be empty");
    if (next.length < minItems) return setError(`Keep at least ${minItems}`);
    if (next.length > maxItems) return setError(`At most ${maxItems}`);
    setError(null);
    onChange(next.map((item) => item.trim()));
  };
  const newItem = () =>
    itemOptions?.[0]?.value ?? `${props.itemPlaceholder ?? "Entry"} ${draft.length + 1}`;

  return (
    <div id={props.id} className="flex flex-col gap-1.5">
      {draft.length === 0 && <p className="px-1 text-xs text-muted">None yet</p>}
      {draft.map((item, i) => {
        const label = `${props.itemPlaceholder ?? "Entry"} ${i + 1}`;
        const set = (text: string) => update(draft.map((d, j) => (j === i ? text : d)));
        return (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-5 text-right text-xs tabular-nums text-muted">{i + 1}</span>
            {itemOptions ? (
              <select
                value={item}
                disabled={props.disabled}
                aria-label={label}
                onChange={(e) => set(e.target.value)}
                className={cx(INPUT, "h-8 cursor-pointer pr-8")}
              >
                {itemOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={item}
                disabled={props.disabled}
                placeholder={props.itemPlaceholder}
                aria-label={label}
                onChange={(e) => set(e.target.value)}
                className={cx(INPUT, "h-8")}
              />
            )}
            <button
              type="button"
              aria-label={`Remove entry ${i + 1}`}
              disabled={props.disabled || draft.length <= minItems}
              onClick={() => update(draft.filter((_, j) => j !== i))}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-danger disabled:pointer-events-none disabled:opacity-30"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={props.disabled || draft.length >= maxItems}
        onClick={() => update([...draft, newItem()])}
        className="self-start rounded-lg px-2 py-1 text-xs font-medium text-brand hover:bg-brand-soft disabled:opacity-40"
      >
        + Add
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
