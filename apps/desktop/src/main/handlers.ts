import type { AppInfo, ReqflowHandlers } from "@reqflow/core/ipc";
import { BMW_DEFAULT_TEMPLATE } from "@reqflow/blocks";
import { ReqflowError } from "./dispatch";

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
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  return {
    app: { info: async () => deps.appInfo() },
    templates: { list: async () => [BMW_DEFAULT_TEMPLATE] },
    workflows: {
      list: notBuilt("workflows.list"),
      get: notBuilt("workflows.get"),
      save: notBuilt("workflows.save"),
      remove: notBuilt("workflows.remove"),
    },
    files: { import: notBuilt("files.import") },
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
