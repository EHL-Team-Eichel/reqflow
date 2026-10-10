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
};

export function partTag(partId: string): string {
  return (
    SHORT_LABELS[partId] ??
    PARTS_BY_ID.get(partId)?.label ??
    (partId === WHOLE_CAR.id ? WHOLE_CAR.label : "Part")
  );
}
