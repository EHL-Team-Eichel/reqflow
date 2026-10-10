import { CATEGORY_LABELS, type Priority } from "@reqflow/core";
import { cx } from "@/lib/cx";
import { XIcon } from "@/components/ui/icons";
import { label, type ClassifiedRequirement, type Confidence } from "./classify";
import { CAR_PARTS, PART_GROUP_LABELS, PARTS_BY_ID, WHOLE_CAR, type PartGroup } from "./parts";
import { EvidenceDetails } from "./EvidenceDetails";

const PRIORITY_LABELS: Record<Priority, string> = {
  must: "Must",
  should: "Should",
  could: "Could",
  wont: "Won't",
};
const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence — check it",
};
const STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  in_review: "In review",
  challenged: "Challenged",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
};

interface Props {
  selected: string | null;
  byPart: ReadonlyMap<string, ClassifiedRequirement[]>;
  counts: ReadonlyMap<string, number>;
  total: number;
  emptyHint: string;
  onSelect: (partId: string | null) => void;
}

/** Right-hand side of the Car tab: the selected part and its requirements, or the part index. */
export function PartPanel(props: Props) {
  if (props.selected) return <PartDetail {...props} partId={props.selected} />;
  return <PartIndex {...props} />;
}

function PartIndex({ counts, total, emptyHint, onSelect }: Props) {
  const groups: PartGroup[] = ["exterior", "interior", "technology"];
  const whole = counts.get(WHOLE_CAR.id) ?? 0;
  return (
    <div className="flex h-full flex-col" data-testid="car-part-index">
      <div className="border-b border-line px-4 pt-1 pb-3 text-sm text-muted">
        {total === 0 ? (
          emptyHint
        ) : (
          <>
            <span className="font-medium text-ink">{total}</span> requirement
            {total === 1 ? "" : "s"} on the car. Click a part, a badge or a row below.
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <PartRow id={WHOLE_CAR.id} name={WHOLE_CAR.label} count={whole} onSelect={onSelect} />
        {groups.map((g) => (
          <div key={g} className="mt-3">
            <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
              {PART_GROUP_LABELS[g]}
            </h3>
            {CAR_PARTS.filter((p) => p.group === g).map((p) => (
              <PartRow
                key={p.id}
                id={p.id}
                name={p.label}
                count={counts.get(p.id) ?? 0}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PartRow(props: {
  id: string;
  name: string;
  count: number;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.id)}
      data-testid={`car-part-${props.id}`}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2"
    >
      <span className={cx("min-w-0 flex-1 truncate", props.count === 0 && "text-muted")}>
        {props.name}
      </span>
      {props.count > 0 && (
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand">
          {props.count}
        </span>
      )}
    </button>
  );
}

function PartDetail({ partId, byPart, emptyHint, onSelect }: Props & { partId: string }) {
  const part = PARTS_BY_ID.get(partId);
  const items = byPart.get(partId) ?? [];
  return (
    <div className="flex h-full flex-col" data-testid="car-part-detail">
      <div className="flex items-start gap-2 border-b border-line px-4 pt-1 pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            {part ? PART_GROUP_LABELS[part.group] : "Overall"}
          </p>
          <h3 className="text-base font-medium text-ink" data-testid="car-part-title">
            {label(partId)}
          </h3>
          <p className="mt-1 text-sm text-muted">{part?.blurb ?? WHOLE_CAR.blurb}</p>
        </div>
        <button
          type="button"
          aria-label="Back to all parts"
          onClick={() => onSelect(null)}
          className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
        data-testid="car-part-requirements"
      >
        {items.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted">
            No requirements from Add to Car on this part yet.
            <br />
            <span className="text-xs">{emptyHint}</span>
          </p>
        ) : (
          items.map((item) => <RequirementCard key={item.requirement.id} item={item} />)
        )}
      </div>
    </div>
  );
}

function RequirementCard({ item }: { item: ClassifiedRequirement }) {
  const { requirement: r, assignment: a } = item;
  return (
    <article className="rounded-lg border border-line bg-panel p-3" data-testid="car-requirement">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-mono">{r.id}</span>
        <span className="ml-auto">{STATUS_LABELS[r.status] ?? r.status}</span>
      </div>
      <h4 className="mt-1 text-sm font-medium text-ink">{r.title}</h4>
      <p className="mt-1 text-sm text-muted">{r.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {r.priority && (
          <Chip strong={r.priority === "must"}>
            {PRIORITY_LABELS[r.priority]}
            {r.score ? ` · ${Math.round(r.score.total)}` : ""}
          </Chip>
        )}
        <Chip warn={r.evidenceLevel === "D" && (r.priority === "must" || r.priority === "should")}>
          Evidence {r.evidenceLevel}
        </Chip>
        <Chip>{CATEGORY_LABELS[r.category]}</Chip>
      </div>
      {r.targets.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {r.targets.map((t) => (
            <li key={t.metric}>
              <span className="text-ink">{t.metric}:</span> {t.target}
            </li>
          ))}
        </ul>
      )}
      <p
        className="mt-2 border-t border-line pt-2 text-xs text-muted"
        data-testid="car-classifier-reason"
      >
        <span className="font-medium text-ink">Auto-classified</span> (
        {CONFIDENCE_LABELS[a.confidence]}): {a.reason}
        {a.alternatives.length > 0 && (
          <> Could also be: {a.alternatives.map((x) => label(x.partId)).join(", ")}.</>
        )}
      </p>
      <EvidenceDetails requirement={r} />
    </article>
  );
}

function Chip(props: { children: React.ReactNode; strong?: boolean; warn?: boolean }) {
  return (
    <span
      className={cx(
        "rounded-full border px-2 py-0.5",
        props.strong
          ? "border-transparent bg-brand-fill text-white"
          : props.warn
            ? "border-transparent bg-warn-soft text-warn"
            : "border-line text-muted",
      )}
    >
      {props.children}
    </span>
  );
}
