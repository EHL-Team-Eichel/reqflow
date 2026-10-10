import { z } from "zod";
import { DecisionStatus, Requirement } from "./requirement";
import { Priority } from "./scoring";

/** Request/response shapes shared by the UI and the route handlers (endpoint list: docs/ARCHITECTURE.md). */

export const DecisionKind = z.enum(["approve", "reject", "defer", "challenge", "reopen"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DECISION_TO_STATUS: Record<DecisionKind, DecisionStatus> = {
  approve: "approved",
  reject: "rejected",
  defer: "deferred",
  challenge: "challenged", // AI answers, then the requirement returns to "in_review"
  reopen: "in_review",
};

/** POST /api/requirements/:id/decision — every human decision needs a rationale. */
export const RequirementDecision = z.object({
  decision: DecisionKind,
  rationale: z.string().trim().min(3),
  priority: Priority.optional(), // optional PM override when approving
});
export type RequirementDecision = z.infer<typeof RequirementDecision>;

/** PATCH /api/requirements/:id — PM edits content; bumps version, audited field by field. */
export const RequirementEdit = Requirement.pick({
  title: true,
  description: true,
  category: true,
  targets: true,
  priority: true,
  priorityRationale: true,
  assumptions: true,
  uncertainties: true,
  findingIds: true,
  conflictingFindingIds: true,
})
  .partial()
  .extend({ rationale: z.string().trim().min(3) })
  .refine((edit) => Object.keys(edit).some((k) => k !== "rationale"), {
    message: "An edit must change at least one field",
  });
export type RequirementEdit = z.infer<typeof RequirementEdit>;

/** Uniform error body for every non-2xx API response. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
