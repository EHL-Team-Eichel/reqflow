import { PARTS_BY_ID, type CarPart, type PartGroup } from "./parts";

export interface PartSubclass {
  id: string;
  label: string;
  group: PartGroup;
  partIds: readonly string[];
}

/** Navigation only: keep the model's part IDs and requirement classification unchanged. */
export const PART_SUBCLASSES: readonly PartSubclass[] = [
  {
    id: "doors",
    label: "Doors",
    group: "exterior",
    partIds: ["front_doors", "rear_doors", "door_handles"],
  },
  {
    id: "body_design",
    label: "Body & design",
    group: "exterior",
    partIds: ["body", "kidney_grille", "hood", "roof", "front_bumper", "rear_bumper", "trunk_lid"],
  },
  {
    id: "exterior_lighting",
    label: "Lighting",
    group: "exterior",
    partIds: ["headlights", "taillights"],
  },
  {
    id: "windows_mirrors",
    label: "Windows & mirrors",
    group: "exterior",
    partIds: ["windshield", "side_windows", "rear_window", "mirrors"],
  },
  { id: "wheels_tyres", label: "Wheels & tyres", group: "exterior", partIds: ["wheels"] },
  {
    id: "seats",
    label: "Seats",
    group: "interior",
    partIds: ["front_seats", "rear_seats"],
  },
  {
    id: "cockpit_controls",
    label: "Cockpit & controls",
    group: "interior",
    partIds: ["dashboard", "steering_wheel", "curved_display", "hud", "center_console"],
  },
  {
    id: "comfort_atmosphere",
    label: "Comfort & atmosphere",
    group: "interior",
    partIds: ["climate", "sound_system", "ambient_light"],
  },
  { id: "luggage_storage", label: "Luggage & storage", group: "interior", partIds: ["luggage"] },
  {
    id: "power_chassis",
    label: "Powertrain & chassis",
    group: "technology",
    partIds: ["drivetrain", "charging_port", "brakes", "suspension"],
  },
  {
    id: "connected_assistance",
    label: "Connectivity & assistance",
    group: "technology",
    partIds: ["antenna", "driver_assistance"],
  },
];

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
