import type { AppInfo, ReqflowHandlers } from "@reqflow/core/ipc";
import { BMW_DEFAULT_TEMPLATE, createBlockRegistry } from "@reqflow/blocks";
import type { LocalFileStore } from "@reqflow/db";
import { ReqflowError } from "./dispatch";
import { previewBlock } from "./preview";

// Owner: WS1 (docs/WORKSTREAMS.md). Every method the UI can call is listed here; the ones not built
// yet fail loudly with code "not_implemented" so the UI can show a clear message instead of hanging.
// Validate every argument with the Zod schemas from @reqflow/core — the renderer is untrusted input.

function notBuilt(method: string, owner = "WS1") {
  return async (): Promise<never> => {
    throw new ReqflowError(
      "not_implemented",
      `${method} is not built yet — owner ${owner}, see docs/WORKSTREAMS.md`,
    );
  };
}

export interface HandlerDeps {
  appInfo: () => AppInfo;
  files: LocalFileStore;
  /** Shows the native open dialog; resolves to the chosen path, or null when cancelled. */
  pickFile: () => Promise<string | null>;
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  const registry = createBlockRegistry();
  return {
    app: { info: async () => deps.appInfo() },
    blocks: { preview: (request) => previewBlock(registry, deps.files, request) },
    templates: { list: async () => [BMW_DEFAULT_TEMPLATE] },
    workflows: {
      list: notBuilt("workflows.list"),
      get: notBuilt("workflows.get"),
      save: notBuilt("workflows.save"),
      remove: notBuilt("workflows.remove"),
    },
    files: {
      import: async () => {
        const path = await deps.pickFile();
        return path ? deps.files.importFile(path) : null;
      },
    },
    runs: {
      start: notBuilt("runs.start"),
      get: notBuilt("runs.get"),
      list: notBuilt("runs.list"),
      blockOutput: notBuilt("runs.blockOutput"),
      resume: notBuilt("runs.resume"),
      cancel: notBuilt("runs.cancel"),
    },
    requirements: {
      list: notBuilt("requirements.list"),
      get: notBuilt("requirements.get"),
      edit: notBuilt("requirements.edit"),
      decide: notBuilt("requirements.decide"),
    },
    audit: { list: notBuilt("audit.list") },
    settings: {
      get: notBuilt("settings.get"),
      save: notBuilt("settings.save"),
      secrets: notBuilt("settings.secrets"),
      setSecret: notBuilt("settings.setSecret"),
    },
    exports: { requirements: notBuilt("exports.requirements") },
  };
}
