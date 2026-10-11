import { z } from "zod";
import { DecisionStatus, MetricTarget, Requirement } from "./requirement";
import { Priority } from "./scoring";
import { ProductScope } from "./scope";
import { PipelineData, DATA_KEYS } from "./pipeline";

/** Request shapes validated in the main process (method list: ./ipc.ts). */

export const DecisionKind = z.enum(["approve", "reject", "defer", "challenge", "reopen"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DECISION_TO_STATUS: Record<DecisionKind, DecisionStatus> = {
  approve: "approved",
  reject: "rejected",
  defer: "deferred",
  challenge: "challenged", // AI answers, then the requirement returns to "in_review"
  reopen: "in_review",
};

/**
 * Which human decisions each status allows. A decided requirement (approved, rejected) must be
 * reopened before anyone decides again; "challenged" waits for the AI's answer or a decision.
 */
export const ALLOWED_DECISIONS: Record<DecisionStatus, readonly DecisionKind[]> = {
  proposed: ["approve", "reject", "defer", "challenge"],
  in_review: ["approve", "reject", "defer", "challenge"],
  challenged: ["approve", "reject", "defer", "reopen"],
  deferred: ["approve", "reject", "challenge", "reopen"],
  approved: ["reopen"],
  rejected: ["reopen"],
};

/** Why a decision isn't allowed on a requirement in this status, or null when it is. */
export function decisionProblem(status: DecisionStatus, decision: DecisionKind): string | null {
  if (ALLOWED_DECISIONS[status].includes(decision)) return null;
  const allowed = ALLOWED_DECISIONS[status].join(", ");
  return `A ${status.replace("_", " ")} requirement can't be given "${decision}"; allowed: ${allowed}.`;
}

/** `requirements.decide(id, …)` — every human decision needs a rationale. */
export const RequirementDecision = z
  .object({
    decision: DecisionKind,
    rationale: z.string().trim().min(3),
    priority: Priority.optional(), // optional PM override, only when approving
  })
  .refine((d) => d.priority === undefined || d.decision === "approve", {
    message: "A priority override is only possible when approving",
    path: ["priority"],
  });
export type RequirementDecision = z.infer<typeof RequirementDecision>;

/** `requirements.edit(id, …)` — PM edits content; bumps version, audited field by field. */
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
  .extend({
    // Every requirement keeps at least one measurable target (briefing).
    targets: z.array(MetricTarget).min(1, "Keep at least one measurable target").optional(),
    rationale: z.string().trim().min(3),
  })
  .refine((edit) => Object.keys(edit).some((k) => k !== "rationale"), {
    message: "An edit must change at least one field",
  });
export type RequirementEdit = z.infer<typeof RequirementEdit>;

/** Uniform error shape returned over IPC (see IpcResult in ./ipc.ts). */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const HIL_SAMPLE_LIMIT = 15;
const reportText = z.string().max(2000);
const reportId = z.string().min(1).max(200);
/** An export-only snapshot. It cannot record a review or change a requirement decision. */
export const HilReportRequest = z
  .object({
    metadata: z.object({
      scope: ProductScope,
      gate: z.object({
        label: reportText.min(1),
        instructions: reportText.optional(),
        reviewer: reportText.min(1),
        approvalsNeeded: z.number().int().min(1).max(100),
      }),
      runId: reportId.startsWith("run_").optional(),
      runStatus: reportText.optional(),
      currentStep: z.object({
        label: reportText.min(1),
        id: reportId,
      }),
      lineageSteps: z
        .array(
          z
            .object({
              id: reportId,
              label: reportText.min(1),
              kind: z.string().min(1).max(100),
              path: z.array(reportId).max(100),
            })
            .strict(),
        )
        .max(1000),
      lineageLinks: z
        .array(
          z
            .object({
              source: reportId,
              target: reportId,
              sourceLabel: reportText,
              targetLabel: reportText,
            })
            .strict(),
        )
        .max(5000),
    }),
    selectedData: PipelineData,
    fullCounts: z
      .object({
        Requirements: z.number().int().nonnegative(),
        Themes: z.number().int().nonnegative(),
        Findings: z.number().int().nonnegative(),
        Records: z.number().int().nonnegative(),
        Sources: z.number().int().nonnegative(),
      })
      .strict(),
    notes: z
      .object({
        objective: reportText.optional(),
        owner: reportText.optional(),
        nextCheckpoint: reportText.optional(),
        openQuestions: reportText.optional(),
      })
      .optional(),
  })
  .superRefine((request, ctx) => {
    const total = DATA_KEYS.reduce((n, key) => n + request.selectedData[key].length, 0);
    if (!total || total > HIL_SAMPLE_LIMIT) {
      ctx.addIssue({
        code: "custom",
        message: `Select between 1 and ${HIL_SAMPLE_LIMIT} data points.`,
      });
    }
    for (const key of DATA_KEYS) {
      const rows = request.selectedData[key];
      const title = (key[0]!.toUpperCase() + key.slice(1)) as keyof typeof request.fullCounts;
      if (rows.length > request.fullCounts[title]) {
        ctx.addIssue({ code: "custom", message: `Selected count exceeds full count for ${key}.` });
      }
      if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        ctx.addIssue({ code: "custom", message: `Duplicate sample IDs in ${key}.` });
      }
    }
    const stepIds = new Set(request.metadata.lineageSteps.map((s) => s.id));
    if (
      stepIds.size !== request.metadata.lineageSteps.length ||
      !stepIds.has(request.metadata.currentStep.id)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Lineage must contain unique steps including the sampled step.",
      });
    }
    if (
      request.metadata.lineageLinks.some(
        (link) => !stepIds.has(link.source) || !stepIds.has(link.target),
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Lineage links must reference included steps." });
    }
  });
export type HilReportRequest = z.infer<typeof HilReportRequest>;
