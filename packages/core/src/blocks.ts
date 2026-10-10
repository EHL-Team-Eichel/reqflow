import { z } from "zod";

/**
 * The building blocks of a data flow: what the palette offers, which ports each block has, and the
 * parameters it takes. Pure data plus validators, so the editor (renderer) and the engine (main)
 * share one definition. Parameters are placeholders until the owning workstream builds the block.
 */

/** Blocks a user can drag from the palette, in palette order. */
export const PALETTE_BLOCK_KINDS = [
  "custom",
  "raw",
  "research",
  "ai_filter",
  "ai_splitter",
  "hil",
  "add_to_car",
] as const;
export type PaletteBlockKind = (typeof PALETTE_BLOCK_KINDS)[number];

/**
 * Boundary blocks exist only inside an inner workplace. They stand for the parent block's ports:
 * a `block_input` emits what arrives on that input port, a `block_output` collects what leaves on
 * that output port. They are created automatically and can't be added or deleted by the user.
 */
export const BOUNDARY_BLOCK_KINDS = ["block_input", "block_output"] as const;
export type BoundaryBlockKind = (typeof BOUNDARY_BLOCK_KINDS)[number];

export const BlockKind = z.enum([...PALETTE_BLOCK_KINDS, ...BOUNDARY_BLOCK_KINDS]);
export type BlockKind = z.infer<typeof BlockKind>;

export function isPaletteBlockKind(kind: string): kind is PaletteBlockKind {
  return (PALETTE_BLOCK_KINDS as readonly string[]).includes(kind);
}
export function isBoundaryBlockKind(kind: string): kind is BoundaryBlockKind {
  return (BOUNDARY_BLOCK_KINDS as readonly string[]).includes(kind);
}

/** Drives the accent color in the editor. */
export type BlockGroup = "structure" | "source" | "ai" | "human" | "output";

export interface PortSpec {
  id: string; // stable within the block: "in", "out", "out-0", "in-2", …
  label: string;
}
export interface BlockPorts {
  inputs: PortSpec[];
  outputs: PortSpec[];
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A file picked with `api.files.import()` (native dialog; the file is copied into the data dir). */
export const FileRef = z.object({ fileId: z.string().min(1), name: z.string().min(1) });
export type FileRef = z.infer<typeof FileRef>;

interface ParamBase {
  key: string;
  label: string;
  help?: string;
  /** Show the field only while another param has this value (e.g. Excel vs database fields). */
  visibleWhen?: { key: string; equals: string | boolean };
}

export type ParamSpec = ParamBase &
  (
    | { type: "text"; default: string; placeholder?: string; maxLength?: number }
    | { type: "textarea"; default: string; placeholder?: string; maxLength?: number }
    | { type: "number"; default: number; min: number; max: number; step?: number; unit?: string }
    | { type: "slider"; default: number; min: number; max: number; step: number; unit?: string }
    | { type: "select"; default: string; options: readonly SelectOption[] }
    | { type: "multiselect"; default: readonly string[]; options: readonly SelectOption[] }
    | { type: "toggle"; default: boolean }
    /** An editable list of labels. Used where each entry becomes a port (splitter, add to car). */
    | {
        type: "list";
        default: readonly string[];
        minItems: number;
        maxItems: number;
        itemPlaceholder?: string;
      }
    | { type: "file"; accept: readonly string[] } // value: FileRef | null
  );

export type ParamType = ParamSpec["type"];
export type BlockParams = Record<string, unknown>;

export interface BlockSpec {
  kind: PaletteBlockKind;
  label: string; // palette and default block title
  description: string; // one sentence for the palette and the inspector
  group: BlockGroup;
  /** True when the block can be expanded into its own workplace (a sub-flow). */
  hasInnerWorkplace: boolean;
  params: readonly ParamSpec[];
  /** Ports may depend on parameters (one output per splitter branch, one input per ranking). */
  ports(params: BlockParams): BlockPorts;
}

const IN: PortSpec = { id: "in", label: "Input" };
const OUT: PortSpec = { id: "out", label: "Output" };
const STREAM: PortSpec = { id: "out", label: "Data stream" };

const MODEL_OPTIONS = [
  { value: "default", label: "Quality model" },
  { value: "fast", label: "Fast model" },
] as const;
const FROM_SETTINGS = { value: "global", label: "From Settings" } as const;

/** `["a", "b"]` → ports `<prefix>-0 "a"`, `<prefix>-1 "b"`. Port ids are positional. */
function listPorts(params: BlockParams, key: string, prefix: "in" | "out"): PortSpec[] {
  const items = params[key];
  if (!Array.isArray(items)) return [];
  return items.map((label, i) => ({ id: `${prefix}-${i}`, label: String(label) }));
}

export const BLOCK_SPECS: { readonly [K in PaletteBlockKind]: BlockSpec & { kind: K } } = {
  custom: {
    kind: "custom",
    label: "Custom",
    description: "An empty block with its own workplace. Build any sub-flow inside it.",
    group: "structure",
    hasInnerWorkplace: true,
    params: [],
    ports: () => ({ inputs: [IN], outputs: [OUT] }),
  },
  raw: {
    kind: "raw",
    label: "Raw",
    description: "Brings in raw data from an Excel file or a database as one unified data stream.",
    group: "source",
    hasInnerWorkplace: false,
    params: [
      {
        key: "source",
        label: "Source",
        type: "select",
        default: "excel",
        options: [
          { value: "excel", label: "Excel upload" },
          { value: "database", label: "Database" },
        ],
      },
      {
        key: "dataset",
        label: "Dataset",
        type: "select",
        default: "customer_feedback",
        options: [
          { value: "customer_feedback", label: "Customer feedback" },
          { value: "equipment_data", label: "Equipment data" },
          { value: "sales_volume", label: "Sales volumes" },
          { value: "customer_study", label: "Customer study" },
          { value: "other", label: "Other" },
        ],
      },
      {
        key: "file",
        label: "Excel or CSV file",
        type: "file",
        accept: [".xlsx", ".csv"],
        help: "Old .xls files: save them as .xlsx or .csv first.",
        visibleWhen: { key: "source", equals: "excel" },
      },
      {
        key: "sheet",
        label: "Sheet",
        type: "text",
        default: "",
        placeholder: "First sheet",
        help: "Excel only. Leave empty for the first sheet.",
        visibleWhen: { key: "source", equals: "excel" },
      },
      {
        key: "dbType",
        label: "Database type",
        type: "select",
        default: "sqlite",
        options: [
          { value: "sqlite", label: "SQLite" },
          { value: "postgres", label: "PostgreSQL (not supported yet)" },
          { value: "mysql", label: "MySQL (not supported yet)" },
          { value: "sqlserver", label: "SQL Server (not supported yet)" },
        ],
        visibleWhen: { key: "source", equals: "database" },
      },
      {
        key: "connection",
        label: "Database file or host",
        type: "text",
        default: "",
        placeholder: "/path/to/data.sqlite",
        help: "SQLite files work today (read-only). Never put passwords here.",
        visibleWhen: { key: "source", equals: "database" },
      },
      {
        key: "query",
        label: "Table or query",
        type: "textarea",
        default: "",
        placeholder: "SELECT * FROM customer_feedback",
        help: "One read-only SELECT statement.",
        visibleWhen: { key: "source", equals: "database" },
      },
    ],
    ports: () => ({ inputs: [], outputs: [STREAM] }),
  },
  research: {
    kind: "research",
    label: "Research",
    description:
      "Searches the web and turns what it finds into a data stream in the same format as Raw.",
    group: "source",
    hasInnerWorkplace: true,
    params: [
      {
        key: "question",
        label: "Research question",
        type: "textarea",
        default: "",
        placeholder: "What do premium sedan owners expect from rear-seat comfort?",
      },
      {
        key: "sources",
        label: "Look at",
        type: "multiselect",
        default: ["reviews", "competitors", "trends"],
        options: [
          { value: "reviews", label: "Owner & press reviews" },
          { value: "competitors", label: "Competitor models" },
          { value: "trends", label: "Market & technology trends" },
          { value: "forums", label: "Forums & social media" },
          { value: "studies", label: "Public studies" },
        ],
      },
      {
        key: "market",
        label: "Market",
        type: "select",
        default: "global",
        options: [
          FROM_SETTINGS,
          { value: "EU", label: "Europe" },
          { value: "CN", label: "China" },
          { value: "US", label: "United States" },
        ],
      },
      {
        key: "maxAgeMonths",
        label: "Max. age",
        type: "number",
        default: 24,
        min: 1,
        max: 120,
        unit: "months",
      },
      { key: "maxResults", label: "Max. results", type: "number", default: 10, min: 1, max: 50 },
    ],
    ports: () => ({ inputs: [], outputs: [STREAM] }),
  },
  ai_filter: {
    kind: "ai_filter",
    label: "AI Filter",
    description: "Keeps only the items that match a criterion you describe in plain language.",
    group: "ai",
    hasInnerWorkplace: true,
    params: [
      {
        key: "criterion",
        label: "Keep items that…",
        type: "textarea",
        default: "",
        placeholder: "…are customer-facing, not regulation, engineering specs or pricing.",
      },
      { key: "model", label: "Model", type: "select", default: "fast", options: MODEL_OPTIONS },
      {
        key: "minConfidence",
        label: "Min. confidence",
        type: "slider",
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: "keepUnsure", label: "Keep unsure items for review", type: "toggle", default: true },
    ],
    ports: () => ({ inputs: [IN], outputs: [{ id: "out", label: "Kept" }] }),
  },
  ai_splitter: {
    kind: "ai_splitter",
    label: "AI Splitter",
    description: "Sorts every item into one of several branches. Each branch is its own output.",
    group: "ai",
    hasInnerWorkplace: false,
    params: [
      {
        key: "splitBy",
        label: "Split by",
        type: "select",
        default: "priority",
        options: [
          { value: "priority", label: "Priority" },
          { value: "category", label: "Requirement category" },
          { value: "sentiment", label: "Sentiment" },
          { value: "custom", label: "Custom instruction" },
        ],
      },
      {
        key: "branches",
        label: "Branches (one output each)",
        type: "list",
        default: ["Must have", "Should have", "Could have"],
        minItems: 2,
        maxItems: 8,
        itemPlaceholder: "Branch name",
      },
      {
        key: "instruction",
        label: "Instruction",
        type: "textarea",
        default: "",
        placeholder: "Route each item to the branch that…",
        visibleWhen: { key: "splitBy", equals: "custom" },
      },
      { key: "model", label: "Model", type: "select", default: "default", options: MODEL_OPTIONS },
    ],
    ports: (params) => ({ inputs: [IN], outputs: listPorts(params, "branches", "out") }),
  },
  hil: {
    kind: "hil",
    label: "HIL",
    description:
      "Human in the loop: the flow waits here until a person has reviewed what passes through.",
    group: "human",
    hasInnerWorkplace: false,
    params: [
      {
        key: "reviewer",
        label: "Reviewer",
        type: "select",
        default: "pm",
        options: [
          { value: "pm", label: "Product manager" },
          { value: "expert", label: "Domain expert" },
          { value: "anyone", label: "Any team member" },
        ],
      },
      {
        key: "instructions",
        label: "Instructions for the reviewer",
        type: "textarea",
        default: "",
        placeholder: "Check that every item is customer-facing and backed by evidence.",
      },
      { key: "approvals", label: "Approvals needed", type: "number", default: 1, min: 1, max: 5 },
      { key: "allowEdits", label: "Reviewer may edit items", type: "toggle", default: true },
    ],
    ports: () => ({ inputs: [IN], outputs: [OUT] }),
  },
  add_to_car: {
    kind: "add_to_car",
    label: "Add to Car",
    description:
      "Adds what arrives to the car's requirements. The input an item arrives on sets its ranking.",
    group: "output",
    hasInnerWorkplace: false,
    params: [
      {
        key: "rankings",
        label: "Rankings (one input each)",
        type: "list",
        default: ["Must have", "Should have", "Could have"],
        minItems: 1,
        maxItems: 6,
        itemPlaceholder: "Ranking name",
      },
      {
        key: "vehicle",
        label: "Vehicle",
        type: "select",
        default: "global",
        options: [
          FROM_SETTINGS,
          { value: "1 Series", label: "1 Series" },
          { value: "5 Series", label: "5 Series" },
          { value: "7 Series", label: "7 Series" },
        ],
      },
      {
        key: "market",
        label: "Market",
        type: "select",
        default: "global",
        options: [
          FROM_SETTINGS,
          { value: "EU", label: "Europe" },
          { value: "CN", label: "China" },
          { value: "US", label: "United States" },
        ],
      },
      { key: "mergeDuplicates", label: "Merge duplicates", type: "toggle", default: true },
    ],
    ports: (params) => ({ inputs: listPorts(params, "rankings", "in"), outputs: [] }),
  },
};

/** Inner-workplace boundary blocks carry the parent port they stand for. */
export const BoundaryParams = z.strictObject({ port: z.string().min(1) });
export type BoundaryParams = z.infer<typeof BoundaryParams>;

function paramSchema(spec: ParamSpec): z.ZodType {
  switch (spec.type) {
    case "text":
    case "textarea":
      return z.string().max(spec.maxLength ?? (spec.type === "text" ? 500 : 5000));
    case "number":
    case "slider":
      return z.number().min(spec.min).max(spec.max);
    case "select":
      return z.enum(spec.options.map((o) => o.value) as [string, ...string[]]);
    case "multiselect": {
      const values = spec.options.map((o) => o.value) as [string, ...string[]];
      return z
        .array(z.enum(values))
        .refine((v) => new Set(v).size === v.length, "Each option may be selected only once");
    }
    case "toggle":
      return z.boolean();
    case "list":
      return z
        .array(z.string().trim().min(1, "Entries can't be empty").max(60))
        .min(spec.minItems)
        .max(spec.maxItems);
    case "file":
      return FileRef.nullable();
  }
}

const paramsSchemaCache = new Map<BlockKind, z.ZodType<BlockParams>>();

/** Strict Zod schema for a block's params: unknown keys and wrong types are errors, not dropped. */
export function blockParamsSchema(kind: BlockKind): z.ZodType<BlockParams> {
  let schema = paramsSchemaCache.get(kind);
  if (!schema) {
    schema = isBoundaryBlockKind(kind)
      ? BoundaryParams
      : z.strictObject(
          Object.fromEntries(BLOCK_SPECS[kind].params.map((p) => [p.key, paramSchema(p)])),
        );
    paramsSchemaCache.set(kind, schema);
  }
  return schema;
}

export function defaultBlockParams(kind: PaletteBlockKind): BlockParams {
  return Object.fromEntries(
    BLOCK_SPECS[kind].params.map((p) => [
      p.key,
      p.type === "file" ? null : Array.isArray(p.default) ? [...p.default] : p.default,
    ]),
  );
}

/** Throws a ZodError naming the bad field. */
export function parseBlockParams(kind: BlockKind, params: unknown): BlockParams {
  return blockParamsSchema(kind).parse(params);
}

/** Whether a param field is shown, given the block's current params. */
export function isParamVisible(spec: ParamSpec, params: BlockParams): boolean {
  return !spec.visibleWhen || params[spec.visibleWhen.key] === spec.visibleWhen.equals;
}

/**
 * Ports of a block. Invalid params fall back to the defaults, so a broken block still renders;
 * `validateGraph` reports the invalid params separately.
 */
export function blockPorts(block: { kind: BlockKind; params: BlockParams }): BlockPorts {
  if (block.kind === "block_input") return { inputs: [], outputs: [OUT] };
  if (block.kind === "block_output") return { inputs: [IN], outputs: [] };
  const parsed = blockParamsSchema(block.kind).safeParse(block.params);
  const params = parsed.success ? parsed.data : defaultBlockParams(block.kind);
  return BLOCK_SPECS[block.kind].ports(params);
}
