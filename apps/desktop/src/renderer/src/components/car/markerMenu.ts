import { PART_SUBCLASSES, type PartSubclass } from "./partMenu";
import type { PartGroup } from "./parts";

export const MENU_GROUPS: readonly PartGroup[] = ["exterior", "interior", "technology"];

export interface MarkerMenuState {
  expanded: ReadonlySet<string>;
  active: string | null;
}

export function initialMarkerMenu(): MarkerMenuState {
  return { expanded: new Set(), active: null };
}

export function menuGroup(id: string): PartGroup {
  if (MENU_GROUPS.includes(id as PartGroup)) return id as PartGroup;
  if (id.startsWith("model_") && MENU_GROUPS.includes(id.slice(6) as PartGroup))
    return id.slice(6) as PartGroup;
  const subclass = PART_SUBCLASSES.find((s) => s.id === id);
  if (!subclass) throw new Error(`Unknown car menu: ${id}`);
  return subclass.group;
}

export function menuPartIds(
  id: string | null,
  subclasses: readonly PartSubclass[] = PART_SUBCLASSES,
): readonly string[] {
  if (id === null) return [];
  const group = menuGroup(id);
  return subclasses
    .filter((s) => s.id === id || (id === group && s.group === group))
    .flatMap((s) => s.partIds);
}

/** Focus the last opened class; closing it restores its parent or clears its markers. */
export function toggleMarkerMenu(state: MarkerMenuState, id: string): MarkerMenuState {
  const group = menuGroup(id);
  const expanded = new Set(state.expanded);
  if (!expanded.has(id)) {
    expanded.add(group);
    expanded.add(id);
    return { expanded, active: id };
  }
  expanded.delete(id);
  if (id === group) {
    expanded.delete(`model_${group}`);
    for (const subclass of PART_SUBCLASSES) {
      if (subclass.group === group) expanded.delete(subclass.id);
    }
  }
  const closesActive =
    state.active === id ||
    (id === group && state.active !== null && menuGroup(state.active) === group);
  return {
    expanded,
    active: closesActive ? (id !== group && expanded.has(group) ? group : null) : state.active,
  };
}

/** Count eligible part markers, not requirements; exactly eight still get labels. */
export function markerPresentation(
  partIds: readonly string[],
  eligible: ReadonlySet<string>,
): { partIds: string[]; compact: boolean } {
  const ids = [...new Set(partIds)].filter((id) => eligible.has(id));
  return { partIds: ids, compact: ids.length > 8 };
}
