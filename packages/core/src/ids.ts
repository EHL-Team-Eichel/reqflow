/** Prefixes keep IDs self-describing in logs, the audit trail and exports. */
export const ID_PREFIX = {
  source: "src",
  record: "rec",
  finding: "fnd",
  theme: "thm",
  workflow: "wf",
  run: "run",
  audit: "aud",
  file: "file",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Requirement IDs are human-readable and stable across versions, e.g. `REQ-5S-EU-007`. */
export const REQUIREMENT_ID_PATTERN = /^REQ-[A-Z0-9]+-[A-Z0-9]+-\d{3,}$/;

const CODE_PATTERN = /^[A-Z0-9]+$/;

/** `seq` is per scope (vehicle × market) and must never be reused, even after a rejection. */
export function formatRequirementId(vehicleCode: string, market: string, seq: number): string {
  if (!CODE_PATTERN.test(vehicleCode)) {
    throw new RangeError(`vehicleCode must be uppercase alphanumeric, got "${vehicleCode}"`);
  }
  if (!CODE_PATTERN.test(market)) {
    throw new RangeError(`market must be uppercase alphanumeric, got "${market}"`);
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError(`Requirement sequence must be a positive integer, got ${seq}`);
  }
  return `REQ-${vehicleCode}-${market}-${String(seq).padStart(3, "0")}`;
}
