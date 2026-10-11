import {
  BLOCK_SPECS,
  DATA_KEYS,
  DEFAULT_SETTINGS,
  PALETTE_BLOCK_KINDS,
  parseBlockParams,
  ProductScope,
  type DataKey,
  type FileStore,
  type LlmClient,
  type PipelineData,
  type Settings,
} from "@reqflow/core";
import type { BlockPreview } from "@reqflow/core/ipc";
import { NO_AGENT_SERVICES, type BlockContext, type BlockRegistry } from "@reqflow/engine";
import { z } from "zod";
import { pdfAiFailureReason } from "../../../../packages/blocks/src/raw/ai-error";
import { ReqflowError } from "./dispatch";

const Request = z.object({
  kind: z.enum(PALETTE_BLOCK_KINDS),
  params: z.record(z.string(), z.unknown()),
  scope: ProductScope,
});

const unavailable = (what: string) => () => {
  throw new Error(`${what} isn't available in a preview; run the flow instead`);
};

export interface PreviewBlockDeps {
  settings?: Settings;
  llm?: LlmClient;
}

export class AiPreviewError extends Error {
  constructor(error?: unknown) {
    super(`AI provider failed to generate a preview response. ${pdfAiFailureReason(error)}.`, {
      cause: error,
    });
    this.name = "AiPreviewError";
  }
}

function safePreviewLlm(client: LlmClient): LlmClient {
  return {
    async generateText(options) {
      try {
        return await client.generateText(options);
      } catch (error) {
        throw new AiPreviewError(error);
      }
    },
    async generateObject(options) {
      try {
        return await client.generateObject(options);
      } catch (error) {
        throw new AiPreviewError(error);
      }
    },
  };
}

export const PREVIEW_LIMIT = 1000;

/**
 * Caps each data list in block outputs at limit (default PREVIEW_LIMIT = 1000) per output port.
 * Returns capped outputs, notes for each truncated list, and a truncated map matching BlockPreview.truncated.
 * Lists under the limit are untouched and truncated is omitted when nothing was cut.
 */
export function capPreview(
  outputs: Record<string, PipelineData>,
  limit = PREVIEW_LIMIT,
): {
  outputs: Record<string, PipelineData>;
  truncated?: Record<string, Partial<Record<DataKey, { shown: number; total: number }>>>;
  notes: string[];
} {
  const cappedOutputs: Record<string, PipelineData> = {};
  const truncated: Record<string, Partial<Record<DataKey, { shown: number; total: number }>>> = {};
  const notes: string[] = [];
  let hasTruncated = false;

  for (const [port, data] of Object.entries(outputs)) {
    const portTruncated: Partial<Record<DataKey, { shown: number; total: number }>> = {};
    const cappedData: PipelineData = { ...data };

    for (const key of DATA_KEYS) {
      const list = data[key];
      if (list && list.length > limit) {
        (cappedData as Record<DataKey, unknown[]>)[key] = list.slice(0, limit);
        portTruncated[key] = { shown: limit, total: list.length };
        hasTruncated = true;
        notes.push(
          `Preview shows the first ${limit.toLocaleString("en-US")} of ${list.length.toLocaleString("en-US")} ${key}; a run uses all of them.`,
        );
      }
    }

    cappedOutputs[port] = cappedData;
    if (Object.keys(portTruncated).length > 0) {
      truncated[port] = portTruncated;
    }
  }

  return {
    outputs: cappedOutputs,
    ...(hasTruncated ? { truncated } : {}),
    notes,
  };
}

/**
 * Runs a block without inputs on its own (blocks.preview). Electron-free so it can be unit-tested.
 * The request comes from the renderer, so it is validated like any untrusted input.
 */
export async function previewBlock(
  registry: BlockRegistry,
  files: FileStore,
  request: unknown,
  deps?: PreviewBlockDeps,
): Promise<BlockPreview> {
  const { kind, params: rawParams, scope } = Request.parse(request);
  const spec = BLOCK_SPECS[kind];
  const params = parseBlockParams(kind, rawParams);
  if (spec.ports(params).inputs.length > 0) {
    throw new ReqflowError(
      "invalid_input",
      `${spec.label} takes inputs, so its data only exists inside a run`,
    );
  }
  if (kind === "research" || kind === "research_opencode") {
    throw new ReqflowError(
      "invalid_input",
      `${spec.label} preview requires saved results. Run the flow first, then preview its saved output.`,
    );
  }
  if (!registry.has(kind)) {
    throw new ReqflowError("not_implemented", `The ${spec.label} block isn't built yet`);
  }

  const logs: string[] = [];
  const settings: Settings = {
    ...(deps?.settings ?? DEFAULT_SETTINGS),
    defaultScope: scope,
  };
  const llm: LlmClient = deps?.llm
    ? safePreviewLlm(deps.llm)
    : { generateObject: unavailable("AI"), generateText: unavailable("AI") };

  const ctx: BlockContext = {
    runId: "preview",
    blockId: "preview",
    scope,
    settings,
    llm,
    agents: NO_AGENT_SERVICES, // only blocks without inputs are previewed; none of them use agents
    audit: {
      record: async (e) => ({
        ...e,
        id: "aud_preview",
        at: new Date().toISOString(),
        changes: e.changes ?? [],
      }),
    }, // previews aren't audited
    files,
    web: null,
    car: { add: unavailable("Adding to the car") },
    log: (m) => logs.push(m),
    progress: () => {},
    signal: new AbortController().signal,
    resumed: false,
  };

  let result;
  try {
    result = await registry.get(kind).run({}, params, ctx);
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (
      !(err instanceof AiPreviewError) &&
      /(\{"error"|api[_-]?key|bearer\s+[a-z0-9_-]+)/i.test(message)
    ) {
      message =
        "AI provider failed to generate a preview response. Check your AI settings and credentials.";
    }
    throw new ReqflowError("block_failed", message, { logs });
  }
  if (result.status !== "ok") throw new ReqflowError("block_failed", result.message, { logs });

  const capped = capPreview(result.outputs, PREVIEW_LIMIT);
  logs.push(...capped.notes);

  return {
    outputs: capped.outputs,
    logs,
    ...(capped.truncated ? { truncated: capped.truncated } : {}),
  };
}
