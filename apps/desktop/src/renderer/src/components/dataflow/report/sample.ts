import { emptyPipelineData, type BlockKind, type PipelineData } from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";

/**
 * SYNTHETIC preview data for the review report, so the data view can be tried before flows can
 * run. It is a slice of the F70 fixtures shaped like what a block of this kind would emit.
 * Always shown with a "synthetic sample" label, never as the flow's real data.
 */
export function sampleDataAt(kind: BlockKind): PipelineData {
  const f = fixturePipelineData;
  const sourcesFrom = (origin: "bmw_internal" | "web") => {
    const sources = f.sources.filter((s) => s.origin === origin);
    const ids = new Set(sources.map((s) => s.id));
    return { sources, records: f.records.filter((r) => ids.has(r.sourceId)) };
  };
  switch (kind) {
    case "raw":
      return { ...emptyPipelineData(), ...sourcesFrom("bmw_internal") };
    case "research":
      return { ...emptyPipelineData(), ...sourcesFrom("web") };
    case "ai_filter":
      return { ...f, requirements: [] };
    default:
      return f;
  }
}
