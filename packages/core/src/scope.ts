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

/**
 * Countries (ISO 3166-1 alpha-2) in each briefing market. "EU" is BMW's European market: the EU
 * plus the EEA, Switzerland and the UK.
 */
export const MARKET_COUNTRIES: Record<string, readonly string[]> = {
  EU: [
    ...["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT"],
    ...["LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
    ...["IS", "LI", "NO", "CH", "GB"],
  ],
  CN: ["CN", "HK", "MO"],
  US: ["US"],
};
const MARKET_ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };

/**
 * Whether a record's market code (a country like "DE" or a market like "EU") lies in a scope
 * market. undefined when the code isn't recognised, so callers can keep it as "market unknown".
 */
export function inMarket(code: string | undefined | null, market: string): boolean | undefined {
  const c = code?.trim().toUpperCase();
  if (!c) return undefined;
  const m = market.trim().toUpperCase();
  const country = MARKET_ALIASES[c] ?? c;
  if (country === m) return true;
  if (MARKET_COUNTRIES[m]?.includes(country)) return true;
  if (country in MARKET_COUNTRIES) return false;
  if (Object.values(MARKET_COUNTRIES).some((list) => list.includes(country))) return false;
  return undefined;
}

/** Requirement-id vehicle code for a briefing line in a market (the long-wheelbase 5 Series is China-only). */
export function vehicleCodeFor(vehicleLine: string, market: string): string | undefined {
  if (vehicleLine === "1 Series") return "F70";
  if (vehicleLine === "5 Series") return market.toUpperCase() === "CN" ? "G68" : "G60";
  if (vehicleLine === "7 Series") return "G70";
  return undefined;
}
