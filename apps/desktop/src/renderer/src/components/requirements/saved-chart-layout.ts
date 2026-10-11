import type { Lineage } from "@reqflow/core";
import { layoutLineage } from "../dataflow/report/layout";

/** The report's narrow overview reads top-to-bottom; the build canvas keeps saved positions. */
export function savedLineageLayout(lineage: Lineage) {
  return Object.fromEntries(
    Object.entries(layoutLineage(lineage)).map(([id, point]) => [
      id,
      { x: point.y * 2, y: point.x / 2 },
    ]),
  );
}
