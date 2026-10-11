import { z } from "zod";
import {
  Requirement,
  RequirementDecision,
  RequirementEdit,
  type MetricTarget,
} from "@reqflow/core";
import type { ReqflowApi } from "@reqflow/core/ipc";

export interface RequirementDraft {
  title: string;
  description: string;
  category: string;
  priority: string;
  priorityRationale: string;
  targets: MetricTarget[];
  assumptions: string;
  uncertainties: string;
}

export function requirementDraft(requirement: Requirement): RequirementDraft {
  return {
    title: requirement.title,
    description: requirement.description,
    category: requirement.category,
    priority: requirement.priority ?? "",
    priorityRationale: requirement.priorityRationale ?? "",
    targets: requirement.targets.map((target) => ({ ...target })),
    assumptions: requirement.assumptions.join("\n"),
    uncertainties: requirement.uncertainties.join("\n"),
  };
}

const nonblank = z.string().trim().min(1, "Must not be blank");
const changedContent = z.object({
  title: nonblank.max(120).optional(),
  description: nonblank.optional(),
  targets: z
    .array(z.object({ metric: nonblank, target: nonblank, acceptance: nonblank }))
    .optional(),
});
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export function buildRequirementEdit(
  requirement: Requirement,
  draft: RequirementDraft,
  rationale: string,
): RequirementEdit {
  const original = requirementDraft(requirement);
  const edit: Record<string, unknown> = { rationale };
  for (const key of [
    "title",
    "description",
    "category",
    "priority",
    "priorityRationale",
  ] as const) {
    if (draft[key] !== original[key] && draft[key].trim() !== original[key].trim()) {
      edit[key] = draft[key].trim();
    }
  }
  for (const key of ["assumptions", "uncertainties"] as const) {
    if (draft[key] !== original[key]) {
      const value = lines(draft[key]);
      if (
        JSON.stringify(value) !==
        JSON.stringify(requirement[key].map((line) => line.trim()).filter(Boolean))
      ) {
        edit[key] = value;
      }
    }
  }
  // Retain the original text of untouched target cells, including any stored whitespace.
  const targets = draft.targets.map((target, index) => {
    const previous = requirement.targets[index];
    return Object.fromEntries(
      (["metric", "target", "acceptance"] as const).map((key) => [
        key,
        previous && target[key].trim() === previous[key].trim()
          ? previous[key]
          : target[key].trim(),
      ]),
    ) as MetricTarget;
  });
  if (JSON.stringify(targets) !== JSON.stringify(requirement.targets)) edit.targets = targets;
  changedContent.parse(edit);
  return RequirementEdit.parse(edit);
}

export function buildRequirementDecision(
  decision: string,
  rationale: string,
  priority = "",
): RequirementDecision {
  if (priority && decision !== "approve") {
    throw new Error("A priority override is only available when approving.");
  }
  return RequirementDecision.parse({ decision, rationale, ...(priority ? { priority } : {}) });
}

export type ReviewSubmission =
  | { kind: "edit"; draft: RequirementDraft; rationale: string }
  | { kind: "decision"; decision: string; rationale: string; priority?: string };
export type ReviewApi = {
  requirements: Pick<ReqflowApi["requirements"], "get" | "edit" | "decide">;
};

/** Version preflight only: the IPC contract does not offer atomic compare-and-swap. */
export async function saveRequirementReview(
  client: ReviewApi,
  shown: Requirement,
  submission: ReviewSubmission,
  isActive: () => boolean = () => true,
): Promise<Requirement> {
  const payload =
    submission.kind === "edit"
      ? buildRequirementEdit(shown, submission.draft, submission.rationale)
      : buildRequirementDecision(submission.decision, submission.rationale, submission.priority);
  if (!isActive()) throw new Error("Review is no longer open.");
  const detail = await client.requirements.get(shown.id);
  if (!isActive()) throw new Error("Review is no longer open.");
  const current = Requirement.parse(detail.requirement);
  if (current.id !== shown.id || current.version !== shown.version) {
    throw new Error("This requirement has changed. Reload its details before saving your review.");
  }
  const saved =
    submission.kind === "edit"
      ? await client.requirements.edit(shown.id, payload as RequirementEdit)
      : await client.requirements.decide(shown.id, payload as RequirementDecision);
  return Requirement.parse(saved);
}

export function reviewError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "Review"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : "Unable to save the review. Please try again.";
}

type OutcomeEvent = { action: string; at: string; rationale?: string };

/** What the PM sees after a challenge: the AI's answer is in History, or why there is none. */
export function challengeOutcome(events: readonly OutcomeEvent[]): string {
  const latest = events
    .filter(
      (event) =>
        event.action === "requirement.challenge_answered" ||
        event.action === "requirement.challenge_failed",
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (!latest) return "Open History for the AI's answer.";
  if (latest.action === "requirement.challenge_failed")
    return latest.rationale ?? "The AI gave no usable answer; challenge again to retry.";
  return "The AI's answer is in History; it is advice, not a decision.";
}
