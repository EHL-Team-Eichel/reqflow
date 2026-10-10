import { useParams } from "react-router";
import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export function RequirementDetailPage() {
  const { id = "" } = useParams();
  return (
    <PagePlaceholder
      title={id}
      purpose="One requirement end to end: description, targets, evidence, rationale, assumptions — and the PM decision."
      owner="WS3"
      builds={[
        "Description + measurable targets; edit in place (api.requirements.edit with rationale)",
        "Linked findings → verbatim evidence excerpts → sources (with reliability + link)",
        "Score breakdown, priority rationale, evidence level, assumptions, uncertainties, conflicting evidence",
        "Decision bar: approve / reject / defer / challenge — rationale required",
        "History tab: this requirement's audit events and version diffs",
      ]}
    />
  );
}
