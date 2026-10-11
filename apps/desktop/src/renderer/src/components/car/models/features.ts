import type { VehicleModel } from "./types";

/**
 * Classifies vehicle models into functional and architectural categories
 * based on their body type, chassis code, series, and equipment.
 */

/** True if the model is a 2-door vehicle (coupe, convertible, roadster, race car). */
export function isTwoDoor(model?: VehicleModel): boolean {
  if (!model) return false;
  // Gran Coupés and Gran Turismos are 4-door / 5-door vehicles
  if (
    model.series === "Gran Coupé" ||
    model.name.includes("Gran Coup") ||
    model.name.includes("Gran Turismo") ||
    model.bodyType === "gran_coupe"
  ) {
    return false;
  }
  return (
    model.bodyType === "coupe" ||
    model.bodyType === "roadster" ||
    model.bodyType === "convertible" ||
    model.bodyType === "race"
  );
}

/** True if the model is a 2-seater (roadsters, M1, track specials with rear seat delete, race cars). */
export function isTwoSeater(model?: VehicleModel): boolean {
  if (!model) return false;
  // Dedicated roadsters and mid-engine sports cars
  if (model.bodyType === "roadster" || model.id.includes("z4") || model.id === "bmw_m1_1979") {
    return true;
  }
  // Pure race cars and factory track specials with rear seat delete
  if (
    model.bodyType === "race" ||
    model.name.includes("GT3") ||
    model.name.includes("GT4") ||
    model.name.includes("DTM") ||
    model.name.includes("GTR") ||
    model.id === "bmw_e92_m3_gts_2011" ||
    model.id === "bmw_m4_gts_2016" ||
    model.id === "bmw_m4_csl_2022" ||
    model.id === "bmw_varis_f82_m4_gts_sema_2019" ||
    model.id === "bmw_30_csl_hommage_concept_2015" ||
    model.id === "bmw_g87_m2_zacoe_sema_2024" ||
    model.id === "bmw_dtm_fiberwerkz_e46_m3_2018" ||
    model.id === "bmw_m2_motoring_e46_m3_2014"
  ) {
    return true;
  }
  return false;
}

/** True if the model is a dedicated pure single-seater race car (FIA GT3, GT4, DTM, GTR). */
export function isSingleSeaterRaceCar(model?: VehicleModel): boolean {
  if (!model) return false;
  return (
    model.name.includes("GT3") ||
    model.name.includes("GT4") ||
    model.name.includes("DTM") ||
    model.name.includes("GTR") ||
    (model.bodyType === "race" && model.specialParts.includes("roll_cage"))
  );
}

/** True if the model is a convertible or roadster with a folding soft-top or retractable roof. */
export function isConvertible(model?: VehicleModel): boolean {
  if (!model) return false;
  return (
    model.bodyType === "convertible" ||
    model.bodyType === "roadster" ||
    model.specialParts.includes("convertible_roof") ||
    model.name.includes("Convertible") ||
    model.name.includes("Cabrio") ||
    model.name.includes("Roadster")
  );
}

/** True if the model is an SUV / SAV / SAC (Sports Activity Vehicle / Coupé). */
export function isSuv(model?: VehicleModel): boolean {
  if (!model) return false;
  return model.bodyType === "suv" || model.series.startsWith("X");
}

/** True if the model is a station wagon / estate (Touring or Gran Turismo). */
export function isTouring(model?: VehicleModel): boolean {
  if (!model) return false;
  return (
    model.bodyType === "touring" ||
    model.name.includes("Touring") ||
    model.name.includes("Gran Turismo")
  );
}

/** True if the model features an aftermarket or factory widebody kit. */
export function isWidebody(model?: VehicleModel): boolean {
  if (!model) return false;
  return (
    model.specialParts.includes("widebody_flares") ||
    model.name.includes("Widebody") ||
    model.name.includes("WideBody") ||
    model.name.includes("LB★WORKS") ||
    model.name.includes("Pandem") ||
    model.name.includes("SEMA")
  );
}

/**
 * Returns the set of part IDs that DO NOT exist on the specified vehicle model.
 *
 * For example:
 * - 2-door coupes and roadsters do not have rear doors (`rear_doors`).
 * - 2-seaters and track race cars do not have rear seats (`rear_seats`, individual rear seats, `rear_air_vents`).
 * - Dedicated single-seater race cars have stripped cockpits with no passenger seat, cup holders,
 *   armrest, glovebox, or wireless charger.
 * - Standard 4-door sedans (like the benchmark 2025 BMW M5 Sedan) have no exclusions.
 */
export function modelExcludedPartIds(model?: VehicleModel): Set<string> {
  const excluded = new Set<string>();
  if (!model) return excluded;

  // 1. 2-door models do not have rear doors
  if (isTwoDoor(model)) {
    excluded.add("rear_doors");
  }

  // 2. 2-seaters and track specials do not have rear seats or rear console air vents
  if (isTwoSeater(model)) {
    excluded.add("rear_seats");
    excluded.add("rear_left_seat");
    excluded.add("rear_center_seat");
    excluded.add("rear_right_seat");
    excluded.add("rear_air_vents");
  }

  // 3. Dedicated single-seater race cars have stripped lightweight motorsport cockpits
  if (isSingleSeaterRaceCar(model)) {
    excluded.add("passenger_seat");
    excluded.add("cup_holders");
    excluded.add("armrest");
    excluded.add("glovebox");
    excluded.add("wireless_charger");
  }

  return excluded;
}
