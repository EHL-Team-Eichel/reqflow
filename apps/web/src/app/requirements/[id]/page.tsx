import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export default async function RequirementDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return (
    <PagePlaceholder
      title={id}
      purpose="One requirement end to end: description, targets, evidence, rationale, assumptions — and the PM decision."
      owner="WS3"
      builds={[
        "Description + measurable targets; edit in place (PATCH with rationale)",
        "Linked findings → verbatim evidence excerpts → sources (with reliability + link)",
        "Score breakdown, priority rationale, evidence level, assumptions, uncertainties, conflicting evidence",
        "Decision bar: approve / reject / defer / challenge — rationale required",
        "History tab: this requirement's audit events and version diffs",
      ]}
    />
  );
}
