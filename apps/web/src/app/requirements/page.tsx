import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export default function RequirementsPage() {
  return (
    <PagePlaceholder
      title="Requirements"
      purpose="The output of a run: what the next vehicle should offer customers, prioritized and backed by evidence — where the PM decides."
      owner="WS3"
      builds={[
        "Board/table of requirements: ID, title, category, priority, score, evidence level, status",
        "Filters by run, status, category, priority, evidence level; sort by score",
        "Score breakdown visual (factor × weight) and 'resume run' when the PM review is done",
        "Export button (JSON / CSV / Markdown)",
      ]}
    />
  );
}
