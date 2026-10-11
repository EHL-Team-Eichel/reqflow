import { PARTS_BY_ID, WHOLE_CAR } from "./parts";

/** Compact point labels; full part names and requirement text stay in the review panel. */
const SHORT_LABELS: Readonly<Record<string, string>> = {
  kidney_grille: "Grille",
  windshield: "Windscreen",
  roof: "Roof",
  antenna: "Antenna",
  door_handles: "Handles",
  mirrors: "Mirrors",
  body: "Body",
  wheels: "Wheels",
  suspension: "Suspension",
  drivetrain: "Drivetrain",
  luggage: "Boot space",
  curved_display: "Display",
  hud: "HUD",
  dashboard: "Dashboard",
  climate: "Climate",
  ambient_light: "Ambient light",
  driver_assistance: "Driver assist",
  motor: "Front motor",
  rear_motor: "Rear motor",
  transmission: "Transmission",
  battery_pack: "Battery pack",
  inverter: "Inverter",
  cooling_system: "Cooling",
  drive_shafts: "Drive shafts",
  differential: "Differential",
  brake_discs: "Brake discs",
  brake_calipers: "Calipers",
  accelerator_pedal: "Gas pedal",
  brake_pedal: "Brake pedal",
  brake_pads: "Brake pads",
  dampers: "Dampers",
  suspension_springs: "Coil springs",
  control_arms: "Control arms",
  driver_seat: "Driver seat",
  passenger_seat: "Passenger seat",
  rear_left_seat: "Rear left",
  rear_center_seat: "Rear centre",
  rear_right_seat: "Rear right",
  headrests: "Headrests",
  seat_belts: "Seat belts",
  instrument_cluster: "Driver display",
  center_touchscreen: "Touchscreen",
  glovebox: "Glovebox",
  air_vents: "Front vents",
  rear_air_vents: "Rear vents",
  gear_selector: "Gear selector",
  idrive_controller: "Controller",
  wireless_charger: "Phone charger",
  cup_holders: "Cup holders",
  armrest: "Armrest",
  door_speakers: "Door speakers",
  tweeters: "Tweeters",
  headliner: "Headliner",
  reading_lights: "Reading lights",
};

export function partTag(partId: string): string {
  return (
    SHORT_LABELS[partId] ??
    PARTS_BY_ID.get(partId)?.label ??
    (partId === WHOLE_CAR.id ? WHOLE_CAR.label : "Part")
  );
}
