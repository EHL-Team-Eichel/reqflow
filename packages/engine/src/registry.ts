import type { DataKey, NodeCategory } from "@reqflow/core";
import { z } from "zod";
import type { NodeDefinition } from "./node";

/** What GET /api/nodes returns for the editor palette and config forms. */
export interface NodeCatalogEntry {
  type: string;
  label: string;
  description: string;
  category: NodeCategory;
  consumes: DataKey[];
  produces: DataKey[];
  configJsonSchema: unknown; // JSON Schema generated from configSchema
}

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>();

  constructor(defs: readonly NodeDefinition[] = []) {
    for (const def of defs) this.register(def);
  }

  register(def: NodeDefinition): void {
    if (this.defs.has(def.type)) {
      throw new Error(`Node type "${def.type}" is already registered`);
    }
    if (!/^[a-z]+\.[a-z_]+$/.test(def.type)) {
      throw new Error(`Node type "${def.type}" must look like "<category>.<snake_name>"`);
    }
    this.defs.set(def.type, def);
  }

  get(type: string): NodeDefinition {
    const def = this.defs.get(type);
    if (!def) throw new Error(`Unknown node type "${type}"`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }

  catalog(): NodeCatalogEntry[] {
    return this.list().map((def) => ({
      type: def.type,
      label: def.label,
      description: def.description,
      category: def.category,
      consumes: def.consumes,
      produces: def.produces,
      configJsonSchema: z.toJSONSchema(def.configSchema, { unrepresentable: "any" }),
    }));
  }
}
