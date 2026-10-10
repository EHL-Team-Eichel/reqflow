import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { newId, validateGraph, Workflow, type WorkflowSave } from "@reqflow/core";
import { ReqflowError } from "./dispatch";

export function getWorkflowsDir(dataDir: string): string {
  return join(dataDir, "workflows");
}

export function listWorkflows(dataDir: string): Workflow[] {
  const dir = getWorkflowsDir(dataDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const workflows: Workflow[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      workflows.push(Workflow.parse(JSON.parse(content)));
    } catch {
      // skip corrupted files
    }
  }

  return workflows.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function getWorkflow(dataDir: string, id: string): Workflow {
  const dir = getWorkflowsDir(dataDir);
  const filePath = join(dir, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new ReqflowError("not_found", `Workflow not found: ${id}`);
  }

  try {
    const content = readFileSync(filePath, "utf8");
    return Workflow.parse(JSON.parse(content));
  } catch (err) {
    throw new ReqflowError("not_found", `Failed to parse workflow ${id}`);
  }
}

export function saveWorkflow(dataDir: string, input: WorkflowSave): Workflow {
  // Validate graph
  const issues = validateGraph({ blocks: input.blocks, edges: input.edges });
  if (issues.length > 0) {
    throw new ReqflowError(
      "invalid_input",
      `Workflow graph has ${issues.length} validation issue(s)`,
      issues,
    );
  }

  const dir = getWorkflowsDir(dataDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const now = new Date().toISOString();
  let workflow: Workflow;

  if (input.id) {
    let existing: Workflow | null = null;
    try {
      existing = getWorkflow(dataDir, input.id);
    } catch {
      existing = null;
    }

    if (existing) {
      workflow = Workflow.parse({
        id: existing.id,
        name: input.name,
        description: input.description,
        scope: input.scope,
        blocks: input.blocks,
        edges: input.edges,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
    } else {
      workflow = Workflow.parse({
        id: input.id,
        name: input.name,
        description: input.description,
        scope: input.scope,
        blocks: input.blocks,
        edges: input.edges,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    workflow = Workflow.parse({
      id: newId("wf"),
      name: input.name,
      description: input.description,
      scope: input.scope,
      blocks: input.blocks,
      edges: input.edges,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  const filePath = join(dir, `${workflow.id}.json`);
  const tmpPath = join(dir, `${workflow.id}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(workflow, null, 2), "utf8");
  renameSync(tmpPath, filePath);

  return workflow;
}

export function removeWorkflow(dataDir: string, id: string): void {
  const dir = getWorkflowsDir(dataDir);
  const filePath = join(dir, `${id}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
