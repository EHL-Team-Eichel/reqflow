import { z } from "zod";

/**
 * How the car is divided, shared by the Car tab (its part menu) and the AI Splitter (its car-part
 * outputs), so feedback split by car part lands in the same places the Car tab shows.
 *
 * Two depths: the three areas, or the thirteen part groups inside them. The parts of each group
 * (`partIds`) are the Car tab's clickable parts (renderer `components/car/parts.ts`).
 */

export const CarArea = z.enum(["exterior", "interior", "technology"]);
export type CarArea = z.infer<typeof CarArea>;

export interface CarAreaInfo {
  id: CarArea;
  label: string;
  /** What belongs here, for the AI that sorts feedback into it. */
  description: string;
}

export const CAR_AREAS: readonly CarAreaInfo[] = [
  {
    id: "exterior",
    label: "Exterior",
    description:
      "Everything seen or touched from outside: body, design, paint, doors, lights, windows, mirrors, wheels and tyres.",
  },
  {
    id: "interior",
    label: "Interior",
    description:
      "The cabin: seats, cockpit, steering wheel, displays and controls, infotainment, climate, sound, ambience, storage and boot space.",
  },
  {
    id: "technology",
    label: "Technology & chassis",
    description:
      "What makes it drive: powertrain, battery, range and charging, brakes, suspension and handling, connectivity and driver assistance.",
  },
];

export interface CarPartGroup {
  id: string;
  label: string;
  area: CarArea;
  partIds: readonly string[];
  description: string;
}

export const CAR_PART_GROUPS: readonly CarPartGroup[] = [
  {
    id: "doors",
    label: "Doors",
    area: "exterior",
    partIds: ["front_doors", "rear_doors", "door_handles"],
    description: "Front and rear doors, door handles, getting in and out.",
  },
  {
    id: "body_design",
    label: "Body & design",
    area: "exterior",
    partIds: ["body", "kidney_grille", "hood", "roof", "front_bumper", "rear_bumper", "trunk_lid"],
    description: "Body, paint and proportions, kidney grille, bonnet, roof, bumpers, boot lid.",
  },
  {
    id: "exterior_lighting",
    label: "Lighting",
    area: "exterior",
    partIds: ["headlights", "taillights"],
    description: "Headlights and tail lights.",
  },
  {
    id: "windows_mirrors",
    label: "Windows & mirrors",
    area: "exterior",
    partIds: ["windshield", "side_windows", "rear_window", "mirrors"],
    description: "Windscreen and wipers, side and rear windows, exterior mirrors, visibility.",
  },
  {
    id: "wheels_tyres",
    label: "Wheels & tyres",
    area: "exterior",
    partIds: ["wheels"],
    description: "Wheels, rims and tyres.",
  },
  {
    id: "seats",
    label: "Seats",
    area: "interior",
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
    description: "Front and rear seats, seating comfort, rear legroom, headrests, seat belts.",
  },
  {
    id: "cockpit_controls",
    label: "Cockpit & controls",
    area: "interior",
    partIds: [
      "dashboard",
      "steering_wheel",
      "accelerator_pedal",
      "brake_pedal",
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
    description:
      "Steering wheel, pedals, dashboard, displays and touchscreen, infotainment and its menus, head-up display, iDrive, centre console, gear selector.",
  },
  {
    id: "comfort_atmosphere",
    label: "Comfort & atmosphere",
    area: "interior",
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
    description:
      "Climate control and vents, sound system, cabin noise, ambient lighting, headliner, reading lights.",
  },
  {
    id: "luggage_storage",
    label: "Luggage & storage",
    area: "interior",
    partIds: ["luggage", "glovebox"],
    description: "Boot and luggage space, glovebox, storage compartments.",
  },
  {
    id: "power_chassis",
    label: "Powertrain",
    area: "technology",
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
    description:
      "Engine or electric motors, transmission, efficiency, battery, range, charging and the charging port.",
  },
  {
    id: "braking",
    label: "Brakes",
    area: "technology",
    partIds: ["brakes", "brake_discs", "brake_calipers", "brake_pads"],
    description: "Brakes, brake feel and brake components.",
  },
  {
    id: "suspension_components",
    label: "Suspension",
    area: "technology",
    partIds: ["suspension", "dampers", "suspension_springs", "control_arms"],
    description: "Suspension, ride comfort, dampers, springs, handling.",
  },
  {
    id: "connected_assistance",
    label: "Connectivity & assistance",
    area: "technology",
    partIds: ["antenna", "driver_assistance"],
    description:
      "Connectivity, apps and online services, driver assistance, parking aids and their sensors.",
  },
];

/** How finely the AI Splitter divides the car. */
export const CarPartDepth = z.enum(["areas", "groups"]);
export type CarPartDepth = z.infer<typeof CarPartDepth>;

export const CAR_PART_DEPTH_LABELS: Record<CarPartDepth, string> = {
  areas: "Areas: exterior, interior, technology",
  groups: "Part groups: seats, cockpit, lighting, …",
};

/** Where feedback goes that is about no particular part (price, dealer, the car as a whole). */
export const OTHER_CAR_PART = {
  id: "other",
  label: "Other (no specific part)",
  description:
    "Needs about no specific part of the car: the car as a whole, brand, price, dealer or service.",
} as const;

export interface CarPartOutput {
  id: string;
  label: string;
  description: string;
}

/** The splitter's outputs at a depth, in port order: the areas or groups, then "Other" last. */
export function carPartOutputs(depth: CarPartDepth): CarPartOutput[] {
  const parts: CarPartOutput[] =
    depth === "areas"
      ? CAR_AREAS.map(({ id, label, description }) => ({ id, label, description }))
      : CAR_PART_GROUPS.map(({ id, label, description }) => ({ id, label, description }));
  return [...parts, { ...OTHER_CAR_PART }];
}
