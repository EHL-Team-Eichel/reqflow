import { Finding, Requirement, Source, SourceRecord } from "@reqflow/core";
import type { RequirementDetail } from "@reqflow/core/ipc";
import { z } from "zod";

const Detail = z.object({
  requirement: Requirement,
  findings: z.array(Finding),
  sources: z.array(Source),
  records: z.array(SourceRecord),
  versions: z.array(Requirement),
});

export type DetailState =
  | { status: "loading" }
  | { status: "ready"; detail: RequirementDetail }
  | { status: "error"; message: string };

/** Cancelling ignores late replies: closing or retrying must never display stale evidence. */
export function loadRequirementDetail(
  id: string,
  get: (id: string) => Promise<RequirementDetail>,
  publish: (state: DetailState) => void,
): () => void {
  let cancelled = false;
  publish({ status: "loading" });
  void Promise.resolve()
    .then(() => get(id))
    .then((value) => {
      if (cancelled) return;
      const detail = Detail.parse(value);
      if (detail.requirement.id !== id || detail.versions.some((r) => r.id !== id)) {
        throw new Error("The returned details do not match this requirement. Please retry.");
      }
      publish({ status: "ready", detail });
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      publish({
        status: "error",
        message:
          error instanceof z.ZodError
            ? "The requirement details are incomplete or invalid. Please retry."
            : error instanceof Error
              ? error.message
              : "Could not load the requirement details. Please retry.",
      });
    });
  return () => {
    cancelled = true;
  };
}
