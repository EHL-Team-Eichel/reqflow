import {
  PipelineData,
  ResearchDataset,
  walkBlocks,
  type ReqflowApi,
  type WorkflowRun,
} from "@reqflow/core";
import { z } from "zod";

export type ResearchExportFormat = "json" | "xlsx" | "csv";
export type RunOutput = Record<string, PipelineData>;

export function canLoadResearchDataset(run: WorkflowRun | null): boolean {
  return (
    !!run &&
    ["completed", "failed", "cancelled"].includes(run.status) &&
    [...walkBlocks(run.graph)].some(({ block }) => block.kind === "research")
  );
}

/** Read persisted originals for the shared run, including failed/cancelled partial collections. */
export async function loadResearchDataset(
  client: { research: Pick<ReqflowApi["research"], "dataset"> },
  runId: string,
): Promise<ResearchDataset> {
  const parsed = ResearchDataset.safeParse(await client.research.dataset(runId));
  if (!parsed.success) throw new Error("Malformed research dataset returned by main.");
  if (parsed.data.runId !== runId) throw new Error("Research dataset belongs to another run");
  return parsed.data;
}

const OutputSchema = z.record(z.string(), PipelineData);

export async function loadRunOutput(
  client: { runs: Pick<ReqflowApi["runs"], "blockOutput"> },
  runId: string,
  blockId: string,
): Promise<RunOutput> {
  const originals = await client.runs.blockOutput(runId, blockId);
  if (!OutputSchema.safeParse(originals).success)
    throw new Error("Malformed block output returned by main.");
  // Validate the envelope, but preview the originals: PipelineData strips ResearchRecord extras.
  // The original metadata, tables and provenance must remain available to inspection/export.
  return originals;
}
