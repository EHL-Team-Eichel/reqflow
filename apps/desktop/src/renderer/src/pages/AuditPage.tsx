import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export function AuditPage() {
  return (
    <PagePlaceholder
      title="Audit trail"
      purpose="Complete, chronological, append-only record of who or what changed what, when, and why."
      owner="WS3"
      builds={[
        "Timeline of audit events: time, actor (AI model / PM / system), action, entity, field changes, rationale",
        "Filters: entity (e.g. one requirement ID), actor type, action, run",
        "Before → after diffs for requirement content, scores, priority, evidence and status",
      ]}
    />
  );
}
