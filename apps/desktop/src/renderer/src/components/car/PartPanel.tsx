import { retainedRequirementParts } from "./modelSwitcher/powertrains";
import { useState } from "react";
import { cx } from "@/lib/cx";
import { XIcon } from "@/components/ui/icons";
import { RequirementCard } from "../requirements/RequirementCard";
import { RequirementDialog } from "../requirements/RequirementDialog";
import { label, type ClassifiedRequirement } from "./classify";
import { PART_GROUP_LABELS, PARTS_BY_ID, WHOLE_CAR } from "./parts";
import { menuCount, type PartSubclass, subclassParts } from "./partMenu";
import { MENU_GROUPS, type MarkerMenuState } from "./markerMenu";
import { useSettings } from "@/lib/settings";
import { isModelPartAvailable, modelMenuParts } from "./model/powertrains";

interface Props {
  availableParts: ReadonlySet<string>;
  subclasses: readonly PartSubclass[];
  selected: string | null;
  markerMenu: MarkerMenuState;
  onMenuToggle: (id: string) => void;
  byPart: ReadonlyMap<string, ClassifiedRequirement[]>;
  counts: ReadonlyMap<string, number>;
  total: number;
  emptyHint: string;
  onSelect: (partId: string | null) => void;
  onWhy: (id: string) => void;
}

/** Right-hand side of the Car tab: the selected part and its requirements, or the part index. */
export function PartPanel(props: Props) {
  if (props.selected) return <PartDetail key={props.selected} {...props} partId={props.selected} />;
  return <PartIndex {...props} />;
}

function PartIndex({
  counts,
  total,
  emptyHint,
  onSelect,
  markerMenu,
  onMenuToggle,
  availableParts,
  subclasses: modelSubclasses,
}: Props) {
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
        {MENU_GROUPS.map((g) => {
          const subclasses = modelSubclasses.filter((subclass) => subclass.group === g);
          return (
            <details
              key={g}
              open={markerMenu.expanded.has(g)}
              className="mt-3"
              data-testid={`car-part-group-${g}`}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  onMenuToggle(g);
                }}
                className={cx(
                  "cursor-pointer rounded-md px-2 py-2 text-xs font-semibold tracking-wide uppercase hover:bg-panel-2 focus-visible:outline-brand",
                  markerMenu.active === g ? "bg-brand-soft text-brand" : "text-ink",
                )}
              >
                {PART_GROUP_LABELS[g]}
                <MenuCount
                  count={menuCount(
                    subclasses.flatMap((s) => s.partIds),
                    counts,
                  )}
                />
              </summary>
              <div className="ml-3 border-l border-line pl-2">
                {subclasses.map((subclass) => (
                  <details
                    key={subclass.id}
                    open={markerMenu.expanded.has(subclass.id)}
                    data-testid={`car-part-subclass-${subclass.id}`}
                  >
                    <summary
                      onClick={(event) => {
                        event.preventDefault();
                        onMenuToggle(subclass.id);
                      }}
                      className={cx(
                        "cursor-pointer rounded-md px-2 py-1.5 text-sm font-medium hover:bg-panel-2 focus-visible:outline-brand",
                        markerMenu.active === subclass.id ? "bg-brand-soft text-brand" : "text-ink",
                      )}
                    >
                      {subclass.label}
                      <MenuCount count={menuCount(subclass.partIds, counts)} />
                    </summary>
                    <div className="ml-3 border-l border-line pl-2">
                      {subclassParts(subclass).map((p) => (
                        <PartRow
                          key={p.id}
                          id={p.id}
                          name={p.label}
                          count={counts.get(p.id) ?? 0}
                          onSelect={onSelect}
                        />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          );
        })}
        {retainedRequirementParts(availableParts, counts).length > 0 && (
          <section
            className="mt-4 border-t border-line pt-3"
            data-testid="car-retained-requirements"
          >
            <h3 className="px-2 text-xs font-semibold text-muted">
              Requirements for other powertrains
            </h3>
            <p className="px-2 py-1 text-xs text-muted">
              These parts are absent from this sketch. Their requirements remain available for
              review.
            </p>
            {retainedRequirementParts(availableParts, counts).map((id) => (
              <PartRow
                key={id}
                id={id}
                name={label(id)}
                count={counts.get(id) ?? 0}
                onSelect={onSelect}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function MenuCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="ml-2 rounded-full bg-brand-soft px-1.5 py-0.5 text-xs font-semibold text-brand normal-case">
      {count}
    </span>
  ) : null;
}

function PartRow(props: {
  id: string;
  name: string;
  count: number;
  onSelect: (id: string) => void;
}) {
  const powertrain = useSettings((s) => s.settings.model.powertrain);
  const available = isModelPartAvailable(props.id, powertrain);
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.id)}
      data-testid={`car-part-${props.id}`}
      data-model-available={available}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2"
    >
      <span className={cx("min-w-0 flex-1 truncate", props.count === 0 && "text-muted")}>
        {props.name}
      </span>
      {!available && <span className="text-[10px] text-muted">Not on model</span>}
      {props.count > 0 && (
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand">
          {props.count}
        </span>
      )}
    </button>
  );
}

function PartDetail({
  partId,
  byPart,
  emptyHint,
  onSelect,
  availableParts,
  onWhy,
}: Props & { partId: string }) {
  const [opened, setOpened] = useState<ClassifiedRequirement | null>(null);
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
          {partId !== WHOLE_CAR.id && !availableParts.has(partId) && (
            <p className="mt-2 text-xs text-muted" data-testid="car-absent-part">
              This part is absent from the selected powertrain sketch. Requirements are retained for
              review.
            </p>
          )}
          {items.length > 0 && (
            <p className="mt-1 text-xs text-muted">
              {items.length} requirement{items.length === 1 ? "" : "s"} · Click for details &
              sources
            </p>
          )}
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
          items.map((item) => (
            <div key={item.requirement.id}>
              <RequirementCard item={item} onOpen={() => setOpened(item)} />
              {item.requirement.confidence && (
                <button
                  type="button"
                  data-testid="car-requirement-why"
                  onClick={() => onWhy(item.requirement.id)}
                  className="mt-1 rounded px-2 py-1 text-xs text-brand hover:bg-brand-soft"
                >
                  Why? View agent reasoning
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {opened && (
        <RequirementDialog
          key={opened.requirement.id}
          item={opened}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}
