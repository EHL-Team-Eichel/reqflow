import type { DecisionStatus, EvidenceLevel, Priority } from "@reqflow/core";

export const PRIORITY_LABELS: Record<Priority, string> = {
  must: "Must",
  should: "Should",
  could: "Could",
  wont: "Won't",
};

export const STATUS_LABELS: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  in_review: "In review",
  challenged: "Challenged",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
};

export const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  A: "Strong — consistent independent sources, including quantitative data",
  B: "Moderate — mostly qualitative sources or minor conflicts",
  C: "Weak — single source or anecdotal evidence",
  D: "Assumption — mainly trends or expert judgement",
};
