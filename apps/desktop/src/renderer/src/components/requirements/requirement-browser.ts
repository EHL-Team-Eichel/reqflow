import {
  CATEGORY_LABELS,
  type DecisionStatus,
  type EvidenceLevel,
  type ExportFormat,
  type Priority,
  type ReqflowApi,
  type Requirement,
  type RequirementCategory,
} from "@reqflow/core";
import { classifyRequirement, type ClassifiedRequirement } from "../car/classify";
import { PRIORITY_LABELS } from "./labels";

export type RequirementBrowserSort = "score" | "updated" | "title";
export interface RequirementBrowserOptions {
  query?: string;
  category?: RequirementCategory;
  status?: DecisionStatus;
  evidence?: EvidenceLevel;
  sort?: RequirementBrowserSort;
}

export interface RequirementBrowserGroup {
  priority: Priority | "unprioritized";
  label: string;
  items: ClassifiedRequirement[];
}

/** Priority is the recorded PM-facing band, not the score suggestion or input rank. */
export function filterAndGroupRequirements(
  requirements: readonly Requirement[],
  options: RequirementBrowserOptions = {},
): RequirementBrowserGroup[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const groups: RequirementBrowserGroup[] = ["must", "should", "could", "wont"].map((priority) => ({
    priority: priority as Priority,
    label: PRIORITY_LABELS[priority as Priority],
    items: [],
  }));
  groups.push({ priority: "unprioritized", label: "Unprioritized", items: [] });
  const matches = requirements
    .map((requirement, index) => ({ requirement, index }))
    .filter(({ requirement: r }) => {
      if (options.category && r.category !== options.category) return false;
      if (options.status && r.status !== options.status) return false;
      if (options.evidence && r.evidenceLevel !== options.evidence) return false;
      return (
        !query ||
        [
          r.id,
          r.title,
          r.description,
          CATEGORY_LABELS[r.category],
          ...r.targets.flatMap((target) => [target.metric, target.target, target.acceptance]),
        ]
          .join("\n")
          .toLowerCase()
          .includes(query)
      );
    });
  matches.sort((a, b) => {
    let difference = 0;
    switch (options.sort ?? "score") {
      case "score": {
        const left = a.requirement.score?.total;
        const right = b.requirement.score?.total;
        difference =
          left === undefined
            ? Number(right !== undefined)
            : right === undefined
              ? -1
              : right - left;
        break;
      }
      case "updated":
        difference = Date.parse(b.requirement.updatedAt) - Date.parse(a.requirement.updatedAt);
        break;
      case "title": {
        // Code-point ordering is reproducible across OS locales; equal titles retain input order.
        const left = a.requirement.title.toLowerCase();
        const right = b.requirement.title.toLowerCase();
        difference = left < right ? -1 : left > right ? 1 : 0;
        break;
      }
    }
    return difference || a.index - b.index;
  });
  for (const { requirement } of matches) {
    const group = groups.find((g) => g.priority === (requirement.priority ?? "unprioritized"))!;
    group.items.push({ requirement, assignment: classifyRequirement(requirement) });
  }
  return groups;
}

export type RequirementExportResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** The IPC contract has no browser filters: this always exports all stored requirements. */
export async function exportAllRequirements(
  format: ExportFormat,
  exporter: ReqflowApi["exports"]["requirements"],
): Promise<RequirementExportResult> {
  try {
    const result = await exporter({ format });
    return result === null ? { status: "cancelled" } : { status: "saved", path: result.path };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not export requirements.",
    };
  }
}
