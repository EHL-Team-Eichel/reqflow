import { z } from "zod";

/**
 * Customer-facing requirement areas (briefing "in scope").
 * Out of scope — and filtered by `analysis.scope_filter`: regulatory/homologation,
 * technical/engineering specs, pricing/business case.
 */
export const RequirementCategory = z.enum([
  "exterior_design",
  "interior_quality", // design & quality perception
  "comfort",
  "space_practicality",
  "usability_controls",
  "infotainment_digital", // infotainment & digital services
  "driver_assistance", // as experienced by the customer
  "driving_experience",
  "range_charging", // as experienced by the customer
  "variants_packages",
]);
export type RequirementCategory = z.infer<typeof RequirementCategory>;

export const CATEGORY_LABELS: Record<RequirementCategory, string> = {
  exterior_design: "Exterior & design",
  interior_quality: "Interior, design & quality perception",
  comfort: "Comfort",
  space_practicality: "Space & practicality",
  usability_controls: "Usability & controls",
  infotainment_digital: "Infotainment & digital services",
  driver_assistance: "Driver assistance (customer view)",
  driving_experience: "Driving experience",
  range_charging: "Range & charging (customer view)",
  variants_packages: "Variants & packages",
};
