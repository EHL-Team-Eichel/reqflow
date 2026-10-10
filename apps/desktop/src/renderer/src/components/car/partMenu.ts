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
    partIds: [
      "front_seats",
      "driver_seat",
      "passenger_seat",
      "rear_seats",
      "rear_left_seat",
      "rear_center_seat",
      "rear_right_seat",
      "headrests",
      "seat_belts",
    ],
  },
  {
    id: "cockpit_controls",
    label: "Cockpit & controls",
    group: "interior",
    partIds: [
      "dashboard",
      "steering_wheel",
      "curved_display",
      "instrument_cluster",
      "center_touchscreen",
      "hud",
      "center_console",
      "gear_selector",
      "idrive_controller",
      "wireless_charger",
      "cup_holders",
      "armrest",
    ],
  },
  {
    id: "comfort_atmosphere",
    label: "Comfort & atmosphere",
    group: "interior",
    partIds: [
      "climate",
      "air_vents",
      "rear_air_vents",
      "sound_system",
      "door_speakers",
      "tweeters",
      "ambient_light",
      "headliner",
      "reading_lights",
    ],
  },
  {
    id: "luggage_storage",
    label: "Luggage & storage",
    group: "interior",
    partIds: ["luggage", "glovebox"],
  },
  {
    id: "power_chassis",
    label: "Powertrain",
    group: "technology",
    partIds: [
      "drivetrain",
      "motor",
      "rear_motor",
      "transmission",
      "battery_pack",
      "inverter",
      "cooling_system",
      "drive_shafts",
      "differential",
      "charging_port",
    ],
  },
  {
    id: "braking",
    label: "Brakes",
    group: "technology",
    partIds: ["brakes", "brake_discs", "brake_calipers"],
  },
  {
    id: "suspension_components",
    label: "Suspension",
    group: "technology",
    partIds: ["suspension", "dampers", "suspension_springs", "control_arms"],
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
