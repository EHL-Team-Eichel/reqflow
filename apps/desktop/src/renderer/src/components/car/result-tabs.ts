export const RESULT_TABS = ["Summary", "Targets", "Evidence"] as const;
export type ResultTab = (typeof RESULT_TABS)[number];

/** Short display only; the complete requirement and evidence remain unchanged. */
export function shortResult(text: string, limit = 220): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}
