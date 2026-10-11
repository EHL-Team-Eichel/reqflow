import {
  BLOCK_SPECS,
  DEFAULT_SETTINGS,
  PALETTE_BLOCK_KINDS,
  parseBlockParams,
  ProductScope,
  type FileStore,
} from "@reqflow/core";
import type { BlockPreview } from "@reqflow/core/ipc";
import { NO_AGENT_SERVICES, type BlockContext, type BlockRegistry } from "@reqflow/engine";
import { z } from "zod";
import { ReqflowError } from "./dispatch";

const Request = z.object({
  kind: z.enum(PALETTE_BLOCK_KINDS),
  params: z.record(z.string(), z.unknown()),
  scope: ProductScope,
});

const unavailable = (what: string) => () => {
  throw new Error(`${what} isn't available in a preview; run the flow instead`);
};

/**
 * Runs a block without inputs on its own (blocks.preview). Electron-free so it can be unit-tested.
 * The request comes from the renderer, so it is validated like any untrusted input.
 */
export async function previewBlock(
  registry: BlockRegistry,
  files: FileStore,
  request: unknown,
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
  const ctx: BlockContext = {
    runId: "preview",
    blockId: "preview",
    scope,
    settings: { ...DEFAULT_SETTINGS, defaultScope: scope },
    llm: { generateObject: unavailable("AI"), generateText: unavailable("AI") },
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
    throw new ReqflowError("block_failed", err instanceof Error ? err.message : String(err), {
      logs,
    });
  }
  if (result.status !== "ok") throw new ReqflowError("block_failed", result.message, { logs });
  return { outputs: result.outputs, logs };
}
