import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { useAnalytics } from "./context";
import { countByCountry } from "./engine/aggregate";
import { formatDay, parseTime } from "./engine/time";
import { topicLabel } from "./engine/topics";
import { SENTIMENTS, UNKNOWN_KEY, type Sentiment } from "./engine/types";
import { formatNumber } from "./charts/format";
import { SENTIMENT_COLOR, SENTIMENT_LABEL } from "./charts/palette";

/**
 * One row of filters above every chart: inputs, countries, sentiment, time range and a phrase
 * search. Filters only narrow what is counted; they never change colours or the data itself.
 */
export function FilterBar({ extent }: { extent: [number, number] | null }) {
  const { dataset, filters, setFilters, inputColor, countryColor } = useAnalytics();
  const countries = useMemo(() => countByCountry(dataset.rows), [dataset]);
  const active =
    !!filters.inputs?.length ||
    !!filters.countries?.length ||
    !!filters.sentiments?.length ||
    !!filters.topics?.length ||
    filters.from != null ||
    filters.to != null ||
    !!filters.search;

  const toggle = <T,>(list: T[] | undefined, value: T): T[] => {
    const set = new Set(list ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return [...set];
  };

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel-2 px-5 py-2 text-xs"
      data-testid="analytics-filters"
    >
      {dataset.inputs.length > 1 && (
        <FilterGroup label="Inputs">
          {dataset.inputs.map((i) => (
            <Chip
              key={i.index}
              active={filters.inputs?.includes(i.index) ?? false}
              color={inputColor(i.index)}
              onClick={() => setFilters({ inputs: toggle(filters.inputs, i.index) })}
            >
              {i.label}
            </Chip>
          ))}
        </FilterGroup>
      )}

      {countries.length > 0 && !(countries.length === 1 && countries[0]!.key === UNKNOWN_KEY) && (
        <CountryPicker
          options={countries.map((c) => ({
            key: c.key,
            label: c.label,
            count: c.count,
            color: c.key === UNKNOWN_KEY ? undefined : countryColor(c.key),
          }))}
          selected={filters.countries ?? []}
          onChange={(next) => setFilters({ countries: next })}
        />
      )}

      {dataset.textual && (
        <FilterGroup label="Sentiment">
          {SENTIMENTS.map((s: Sentiment) => (
            <Chip
              key={s}
              active={filters.sentiments?.includes(s) ?? false}
              color={SENTIMENT_COLOR[s]}
              onClick={() => setFilters({ sentiments: toggle(filters.sentiments, s) })}
            >
              {SENTIMENT_LABEL[s]}
            </Chip>
          ))}
        </FilterGroup>
      )}

      {extent && (
        <FilterGroup label="Time">
          <DateField
            label="From"
            value={filters.from ?? null}
            placeholder={formatDay(extent[0])}
            onChange={(t) => setFilters({ from: t })}
          />
          <span className="text-muted">–</span>
          <DateField
            label="Until"
            value={filters.to != null ? filters.to - 86_400_000 : null}
            placeholder={formatDay(extent[1])}
            onChange={(t) => setFilters({ to: t === null ? null : t + 86_400_000 })}
          />
        </FilterGroup>
      )}

      {dataset.textual && (
        <SearchField value={filters.search ?? ""} onChange={(search) => setFilters({ search })} />
      )}

      {filters.topics?.length ? (
        <FilterGroup label="Topics">
          {filters.topics.map((t) => (
            <Chip key={t} active onClick={() => setFilters({ topics: toggle(filters.topics, t) })}>
              {topicLabel(t)} ×
            </Chip>
          ))}
        </FilterGroup>
      ) : null}

      {active && (
        <button
          type="button"
          data-testid="analytics-reset-filters"
          className="ml-auto rounded-md px-2 py-1 font-medium text-brand hover:bg-brand-soft"
          onClick={() =>
            setFilters({
              inputs: [],
              countries: [],
              sentiments: [],
              topics: [],
              from: null,
              to: null,
              search: "",
            })
          }
        >
          Reset filters
        </button>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-0.5 font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean;
  color?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "flex h-6 items-center gap-1.5 rounded-full border px-2 font-medium transition",
        active
          ? "border-brand bg-brand-soft text-ink"
          : "border-line bg-panel text-muted hover:text-ink",
      )}
    >
      {color && (
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-full"
          style={{ background: color }}
        />
      )}
      {children}
    </button>
  );
}

function CountryPicker({
  options,
  selected,
  onChange,
}: {
  options: { key: string; label: string; count: number; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const summary =
    selected.length === 0
      ? "All countries"
      : selected.length <= 3
        ? selected.map((k) => options.find((o) => o.key === k)?.label ?? k).join(", ")
        : `${selected.length} countries`;
  return (
    <div className="relative" ref={ref}>
      <FilterGroup label="Country">
        <button
          type="button"
          data-testid="analytics-country-filter"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cx(
            "flex h-6 items-center gap-1 rounded-full border px-2.5 font-medium",
            selected.length
              ? "border-brand bg-brand-soft text-ink"
              : "border-line bg-panel text-muted",
          )}
        >
          {summary} ▾
        </button>
      </FilterGroup>
      {open && (
        <div className="absolute top-8 left-0 z-20 max-h-80 w-64 overflow-auto rounded-lg border border-line bg-panel p-1 shadow-xl">
          {options.map((o) => (
            <label
              key={o.key}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ink hover:bg-panel-2"
            >
              <input
                type="checkbox"
                className="accent-brand"
                checked={selected.includes(o.key)}
                onChange={() =>
                  onChange(
                    selected.includes(o.key)
                      ? selected.filter((k) => k !== o.key)
                      : [...selected, o.key],
                  )
                }
              />
              {o.color && (
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-full"
                  style={{ background: o.color }}
                />
              )}
              <span className="flex-1 truncate">{o.label}</span>
              <span className="text-muted tabular-nums">{formatNumber(o.count)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function DateField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  onChange: (t: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : formatDay(value));
  useEffect(() => setDraft(value === null ? "" : formatDay(value)), [value]);
  const commit = () => {
    if (!draft.trim()) return onChange(null);
    const t = parseTime(draft);
    if (t !== null) onChange(t);
    else setDraft(value === null ? "" : formatDay(value));
  };
  return (
    <input
      aria-label={`${label} date`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="h-6 w-24 rounded-md border border-line bg-panel px-1.5 text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none"
    />
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Counting 10k+ comments on every key stroke is wasteful: apply after a short pause.
  useEffect(() => {
    if (draft === value) return;
    const id = setTimeout(() => onChange(draft), 250);
    return () => clearTimeout(id);
  }, [draft, value, onChange]);
  return (
    <FilterGroup label="Says">
      <input
        type="search"
        data-testid="analytics-search"
        aria-label="Only records that say"
        value={draft}
        placeholder='e.g. seat | "head-up display" | charg*'
        onChange={(e) => setDraft(e.target.value)}
        className="h-6 w-60 rounded-md border border-line bg-panel px-2 text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none"
      />
    </FilterGroup>
  );
}
