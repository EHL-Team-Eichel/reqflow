import { z } from "zod";

/** Vehicle lines and markets named in the briefing. The schema stays open so other lines/markets work too. */
export const KNOWN_VEHICLE_LINES = ["1 Series", "5 Series", "7 Series"] as const;
export const KNOWN_MARKETS = ["EU", "CN", "US"] as const;

/** What a workflow run is about: one derivative in one market, looking `horizonYears` ahead. */
export const ProductScope = z.object({
  vehicleLine: z.string().min(1), // "1 Series"
  derivative: z.string().min(1).optional(), // "5-door", "Sedan", "Touring"
  vehicleCode: z.string().regex(/^[A-Z0-9]{1,6}$/), // short code used in requirement IDs, e.g. "F70"
  market: z.string().regex(/^[A-Z0-9]{2,6}$/), // "EU" | "CN" | "US" | …
  horizonYears: z.number().int().min(1).max(10), // briefing: think 3–5 years ahead
});
export type ProductScope = z.infer<typeof ProductScope>;
