import {
  AuditEvent,
  PipelineData,
  WorkflowRun,
  addToCarInputs,
  graphAt,
  mergePipelineData,
  traceLineage,
  walkBlocks,
  type Lineage,
  type LineageStep,
  type Requirement,
  type ReqflowApi,
} from "@reqflow/core";
import { loadRunData } from "../dataflow/report/run-data";

export interface RequirementOrigin {
  run: WorkflowRun;
  step: LineageStep;
  lineage: Lineage;
}

export type OriginState =
  | { status: "loading" }
  | { status: "ready"; origin: RequirementOrigin }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

type OriginApi = Pick<ReqflowApi, "runs" | "audit">;

/** Use the creation audit, never the newest run, a matching label, or the editor's live graph. */
export async function resolveRequirementOrigin(
  requirement: Requirement,
  api: OriginApi,
): Promise<RequirementOrigin | null> {
  if (!requirement.runId) return null;
  const [runValue, auditValues] = await Promise.all([
    api.runs.get(requirement.runId),
    api.audit.list({
      entityType: "requirement",
      entityId: requirement.id,
      action: "requirement.proposed",
      runId: requirement.runId,
    }),
  ]);
  const parsedRun = WorkflowRun.safeParse(runValue);
  const parsedAudits = AuditEvent.array().safeParse(auditValues);
  if (!parsedRun.success || !parsedAudits.success)
    throw new Error("The saved workflow provenance is incomplete or invalid.");
  const run = parsedRun.data;
  if (run.id !== requirement.runId)
    throw new Error("The saved run does not match this requirement's origin.");
  const blockIds = new Set(
    parsedAudits.data
      .filter(
        (event) =>
          event.entityType === "requirement" &&
          event.entityId === requirement.id &&
          event.action === "requirement.proposed" &&
          event.runId === run.id &&
          event.blockId,
      )
      .map((event) => event.blockId!),
  );
  if (!blockIds.size) return null;
  if (blockIds.size !== 1)
    throw new Error("More than one originating block was recorded for this requirement.");
  const blockId = [...blockIds][0]!;
  const found = [...walkBlocks(run.graph)].find(({ block }) => block.id === blockId);
  if (!found || found.block.kind !== "add_to_car")
    throw new Error("The originating Add to Car block is missing from the saved run.");

  // Keep shared context, but exclude other priority inputs from this option's lineage.
  const root = structuredClone(run.graph);
  const graph = graphAt(root, found.path);
  graph.edges = graph.edges.filter(
    (edge) =>
      edge.target !== blockId || isRequirementInput(requirement, found.block, edge.targetPort),
  );
  const lineage = traceLineage(root, found.path, blockId);
  return { run, step: lineage.steps.find((step) => step.block.id === blockId)!, lineage };
}

function isRequirementInput(requirement: Requirement, block: LineageStep["block"], port: string) {
  const { priorities, contexts } = addToCarInputs(block.params);
  if (
    requirement.inputRank !== undefined &&
    !priorities.some((p) => p.rank === requirement.inputRank)
  )
    throw new Error("This requirement's priority input is missing from the saved block.");
  return (
    contexts.some((input) => input.port === port) ||
    priorities.some(
      (input) =>
        input.port === port &&
        (requirement.inputRank === undefined || input.rank === requirement.inputRank),
    )
  );
}

/** Late responses cannot replace a newly opened option, a retry, or a closed dialog. */
export function loadRequirementOrigin(
  requirement: Requirement,
  api: OriginApi,
  publish: (state: OriginState) => void,
): () => void {
  let cancelled = false;
  publish({ status: "loading" });
  void resolveRequirementOrigin(requirement, api).then(
    (origin) => {
      if (!cancelled)
        publish(
          origin
            ? { status: "ready", origin }
            : {
                status: "unavailable",
                message:
                  "No exact workflow origin was recorded for this requirement. Its linked evidence and sources remain available.",
              },
        );
    },
    (error: unknown) => {
      if (!cancelled)
        publish({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not read the saved workflow origin.",
        });
    },
  );
  return () => {
    cancelled = true;
  };
}

/** Add to Car is a sink: inspect its exact saved input ports, not its (empty) output. */
export async function loadOriginStepData(
  origin: RequirementOrigin,
  requirement: Requirement,
  step: LineageStep,
  blockOutput: ReqflowApi["runs"]["blockOutput"],
): Promise<PipelineData> {
  if (step.block.id !== origin.step.block.id) return loadRunData(origin.run, step, blockOutput);
  const incoming = graphAt(origin.run.graph, step.path).edges.filter(
    (edge) =>
      edge.target === step.block.id && isRequirementInput(requirement, step.block, edge.targetPort),
  );
  if (!incoming.length) throw new Error("The originating block has no saved input connections.");
  const reads = new Map<string, ReturnType<typeof blockOutput>>();
  const data = await Promise.all(
    incoming.map(async (edge) => {
      if (!reads.has(edge.source)) reads.set(edge.source, blockOutput(origin.run.id, edge.source));
      const outputs = await reads.get(edge.source)!;
      const value = outputs[edge.sourcePort];
      if (!value)
        throw new Error(`Saved input data is missing for ${edge.source}.${edge.sourcePort}.`);
      const parsed = PipelineData.safeParse(value);
      if (!parsed.success) throw new Error("The saved input data is incomplete or invalid.");
      return parsed.data;
    }),
  );
  return mergePipelineData(...data);
}
