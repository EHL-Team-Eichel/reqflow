import { newId, Workflow, type WorkflowSave } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class SqliteWorkflowRepository {
  constructor(private readonly db: DatabaseSync) {}

  async list(): Promise<Workflow[]> {
    const stmt = this.db.prepare(
      "SELECT id, version, name, description, scope, graph, created_at, updated_at FROM workflows ORDER BY updated_at DESC",
    );
    const rows = stmt.all() as Array<{
      id: string;
      version: number;
      name: string;
      description: string | null;
      scope: string;
      graph: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => {
      const graph = JSON.parse(r.graph);
      return Workflow.parse({
        id: r.id,
        version: r.version,
        name: r.name,
        description: r.description ?? undefined,
        scope: JSON.parse(r.scope),
        nodes: graph.nodes,
        edges: graph.edges,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    });
  }

  async get(id: string): Promise<Workflow> {
    const stmt = this.db.prepare(
      "SELECT id, version, name, description, scope, graph, created_at, updated_at FROM workflows WHERE id = ?",
    );
    const r = stmt.get(id) as
      | {
          id: string;
          version: number;
          name: string;
          description: string | null;
          scope: string;
          graph: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!r) {
      throw new Error(`Workflow not found: ${id}`);
    }

    const graph = JSON.parse(r.graph);
    return Workflow.parse({
      id: r.id,
      version: r.version,
      name: r.name,
      description: r.description ?? undefined,
      scope: JSON.parse(r.scope),
      nodes: graph.nodes,
      edges: graph.edges,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  async save(input: WorkflowSave): Promise<Workflow> {
    const now = new Date().toISOString();
    let workflow: Workflow;

    if (input.id) {
      let existing: Workflow | null = null;
      try {
        existing = await this.get(input.id);
      } catch {
        existing = null;
      }

      if (existing) {
        workflow = Workflow.parse({
          id: existing.id,
          name: input.name,
          description: input.description,
          scope: input.scope,
          nodes: input.nodes,
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
          nodes: input.nodes,
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
        nodes: input.nodes,
        edges: input.edges,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    const graph = JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges });
    const stmt = this.db.prepare(`
      INSERT INTO workflows (id, version, name, description, scope, graph, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        name = excluded.name,
        description = excluded.description,
        scope = excluded.scope,
        graph = excluded.graph,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      workflow.id,
      workflow.version,
      workflow.name,
      workflow.description ?? null,
      JSON.stringify(workflow.scope),
      graph,
      workflow.createdAt,
      workflow.updatedAt,
    );

    return workflow;
  }

  async remove(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM workflows WHERE id = ?");
    stmt.run(id);
  }
}
