import { CAR_PART_GROUPS } from "@reqflow/core";
import { PARTS_BY_ID, type CarPart, type PartGroup } from "./parts";

export interface PartSubclass {
  id: string;
  label: string;
  group: PartGroup;
  partIds: readonly string[];
}

/**
 * Navigation only: keep the model's part IDs and requirement classification unchanged. The groups
 * come from `@reqflow/core`, which the AI Splitter's car-part outputs use too.
 */
export const PART_SUBCLASSES: readonly PartSubclass[] = CAR_PART_GROUPS.map(
  ({ id, label, area, partIds }) => ({ id, label, group: area, partIds }),
);

export function subclassParts(subclass: PartSubclass): CarPart[] {
  return subclass.partIds.map((id) => {
    const part = PARTS_BY_ID.get(id);
    if (!part) throw new Error(`Unknown car part in ${subclass.id}: ${id}`);
    return part;
  });
}

export function menuCount(partIds: readonly string[], counts: ReadonlyMap<string, number>): number {
  return partIds.reduce((total, id) => total + (counts.get(id) ?? 0), 0);
}
