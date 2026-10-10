import { BMW_DEFAULT_TEMPLATE, createBlockRegistry } from "@reqflow/blocks";
import type {
  AppInfo,
  AuditFilter,
  ReqflowHandlers,
  RequirementFilter,
  WorkflowSave,
} from "@reqflow/core/ipc";
import type { LocalFileStore } from "@reqflow/db";
import { ReqflowError } from "./dispatch";
import {
  getFixtureRequirement,
  listFixtureAuditEvents,
  listFixtureRequirements,
} from "./fixture-service";
import { previewBlock } from "./preview";
import { loadSettings, saveSettings } from "./settings-storage";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "./workflow-storage";

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
  dataDir?: string;
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  const registry = createBlockRegistry();
  const info = deps.appInfo();
  const dataDir = deps.dataDir ?? info.dataDir;

  return {
    app: { info: async () => deps.appInfo() },
    blocks: { preview: (request) => previewBlock(registry, deps.files, request) },
    templates: { list: async () => [BMW_DEFAULT_TEMPLATE] },
    workflows: {
      list: async () => listWorkflows(dataDir),
      get: async (id: string) => getWorkflow(dataDir, id),
      save: async (input: WorkflowSave) => saveWorkflow(dataDir, input),
      remove: async (id: string) => removeWorkflow(dataDir, id),
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
      list: async (filter?: RequirementFilter) => listFixtureRequirements(filter),
      get: async (id: string) => getFixtureRequirement(id),
      edit: notBuilt("requirements.edit"),
      decide: notBuilt("requirements.decide"),
    },
    audit: {
      list: async (filter?: AuditFilter) => listFixtureAuditEvents(filter),
    },
    settings: {
      get: async () => loadSettings(dataDir),
      save: async (settings) => saveSettings(dataDir, settings),
      secrets: notBuilt("settings.secrets"),
      setSecret: notBuilt("settings.setSecret"),
    },
    exports: { requirements: notBuilt("exports.requirements") },
  };
}
