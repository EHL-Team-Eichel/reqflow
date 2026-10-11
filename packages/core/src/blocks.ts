import { z } from "zod";
import { CAR_PART_DEPTH_LABELS, CarPartDepth, carPartOutputs } from "./car-parts";
import { RESEARCH_AGENT_IDS } from "./research";
import { FILTER_CUSTOMER_CRITERION } from "./filter-report";

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
  "analytics",
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
export type BlockGroup = "structure" | "source" | "ai" | "human" | "output" | "insight";

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
  /**
   * Show the field only while another param has this value (e.g. Excel vs database fields), or,
   * with `notEquals`, while it has any other value.
   */
  visibleWhen?:
    { key: string; equals: string | boolean } | { key: string; notEquals: string | boolean };
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
    /**
     * An editable list. Each entry becomes a port (splitter branches, Add to Car context inputs).
     * With `itemOptions`, every entry is one of those values (a select per entry, not free text).
     */
    | {
        type: "list";
        default: readonly string[];
        minItems: number;
        maxItems: number;
        itemPlaceholder?: string;
        itemOptions?: readonly SelectOption[];
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

/**
 * The AI Splitter's output labels, in port order. Split by car parts, they follow the chosen depth
 * (areas or part groups, then Other); otherwise they are the user's branch list.
 */
export function splitterOutputLabels(params: BlockParams): string[] {
  if (params.splitBy === "car_parts") {
    const depth = CarPartDepth.safeParse(params.partDepth);
    return carPartOutputs(depth.success ? depth.data : "areas").map((o) => o.label);
  }
  return listPorts(params, "branches", "out").map((p) => p.label);
}

/** Add to Car: how a context input is read. "auto" lets the agents work out what the data is. */
export const ContextMode = z.enum(["auto", "sales_volumes"]);
export type ContextMode = z.infer<typeof ContextMode>;
export const CONTEXT_MODE_LABELS: Record<ContextMode, string> = {
  auto: "Auto",
  sales_volumes: "Sales volumes",
};
const CONTEXT_MODE_OPTIONS: readonly SelectOption[] = ContextMode.options.map((value) => ({
  value,
  label: CONTEXT_MODE_LABELS[value],
}));
export const MAX_PRIORITY_INPUTS = 10;
export const MAX_CONTEXT_INPUTS = 5;
export const MAX_ANALYTICS_INPUTS = 8;

/** Analytics: time buckets of the timeline. "auto" picks one from the span of the data. */
export const TimeGranularity = z.enum(["auto", "day", "week", "month", "quarter", "year"]);
export type TimeGranularity = z.infer<typeof TimeGranularity>;

/**
 * The inputs of an Analytics block: one port per named entry of `inputs` (`in-0` "Input 1", …).
 * Each input is one data source the analytics view can compare with the others.
 */
export function analyticsInputs(params: BlockParams): PortSpec[] {
  const ports = listPorts(params, "inputs", "in");
  return ports.length ? ports : [{ id: "in-0", label: "Input 1" }];
}

/** "1. Priority" is the most important input. Ports `in-0`, `in-1`, … keep older flows wired. */
export function priorityPortLabel(rank: number): string {
  return `${rank}. Priority`;
}
export function contextPortLabel(index: number, mode: ContextMode): string {
  return `Context ${index + 1} · ${CONTEXT_MODE_LABELS[mode]}`;
}

export interface PriorityInput {
  port: string; // "in-0"
  rank: number; // 1 = most important
  label: string; // "1. Priority"
}
export interface ContextInput {
  port: string; // "ctx-0"
  index: number;
  mode: ContextMode;
  label: string; // "Context 1 · Sales volumes"
}

/** The inputs of an Add to Car block, from its params. Invalid entries are skipped, not guessed. */
export function addToCarInputs(params: BlockParams): {
  priorities: PriorityInput[];
  contexts: ContextInput[];
} {
  const n = Number(params.priorities);
  const count = Number.isInteger(n) ? Math.max(1, Math.min(MAX_PRIORITY_INPUTS, n)) : 3;
  const priorities = Array.from({ length: count }, (_, i) => ({
    port: `in-${i}`,
    rank: i + 1,
    label: priorityPortLabel(i + 1),
  }));
  const modes = Array.isArray(params.contexts) ? params.contexts : [];
  const contexts = modes.flatMap((value, index) => {
    const mode = ContextMode.safeParse(value);
    return mode.success
      ? [
          {
            port: `ctx-${index}`,
            index,
            mode: mode.data,
            label: contextPortLabel(index, mode.data),
          },
        ]
      : [];
  });
  return { priorities, contexts };
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
    description: "Brings in Excel, CSV, PDF, Research JSON or SQLite data as one unified stream.",
    group: "source",
    hasInnerWorkplace: false,
    params: [
      {
        key: "source",
        label: "Source",
        type: "select",
        default: "excel",
        options: [
          { value: "excel", label: "File upload" },
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
        label: "Excel, CSV, PDF or Research JSON file",
        type: "file",
        accept: [".xlsx", ".csv", ".pdf", ".json"],
        help: "PDF preview/run uses local OCR and sends extracted text to the configured default AI. AI interpretations need review. Research JSON preserves provenance. Save old .xls files as .xlsx or .csv first.",
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
      {
        key: "marketFilter",
        label: "Markets",
        type: "select",
        default: "scope",
        options: [
          { value: "scope", label: "Only the selected market" },
          { value: "all", label: "All markets" },
        ],
        help: "Rows from other markets are left out and counted in the log. Rows without a recognisable market are kept and marked as market unknown.",
      },
      {
        key: "columns",
        label: "Column mapping",
        type: "text",
        default: "",
        placeholder: "text=Kundenkommentar; market=Land",
        help: "Only needed when a column isn't recognised. role=Header pairs separated by semicolons. Roles: text, id, market, language, model, derivative, option, category, takeRate, units, period.",
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
      {
        key: "agents",
        label: "Research agents",
        type: "multiselect",
        default: ["editorial_reviews", "competitor_models", "technology"],
        options: RESEARCH_AGENT_IDS.map((value) => ({ value, label: value.replaceAll("_", " ") })),
      },
      {
        key: "scopeJson",
        label: "Advanced research scope (JSON)",
        type: "textarea",
        default: "{}",
        help: "Vehicle generations, languages, markets, publication dates, competitors, URLs, documentIds and Eurostat datasets. See docs/research/README.md. Missing source metadata stays unknown.",
      },
      {
        key: "queryPlanning",
        label: "Mastra query planning (optional model request)",
        type: "toggle",
        default: false,
        help: "Optional neutral search-query planning using the selected Anthropic, OpenAI or Google Gemini fast model. Requires its API key and may incur usage costs. Original source content is never sent to the planner.",
      },
      {
        key: "document",
        label: "Local original document",
        type: "file",
        accept: [".xlsx", ".txt", ".pdf", ".docx", ".pptx"],
      },
      {
        key: "maxRequests",
        label: "Request limit (all agents)",
        type: "number",
        default: 100,
        min: 1,
        max: 1000,
      },
      {
        key: "maxDocumentPages",
        label: "Document page limit",
        type: "number",
        default: 20,
        min: 1,
        max: 500,
      },
      {
        key: "timeoutMs",
        label: "Time limit",
        type: "number",
        default: 120000,
        min: 1000,
        max: 900000,
        unit: "ms",
      },
      {
        key: "concurrency",
        label: "Parallel requests",
        type: "number",
        default: 3,
        min: 1,
        max: 8,
      },
    ],
    ports: () => ({ inputs: [], outputs: [STREAM] }),
  },
  ai_filter: {
    kind: "ai_filter",
    label: "AI Filter",
    description:
      "Selects relevant original items unchanged, with a reviewable reason for each decision.",
    group: "ai",
    hasInnerWorkplace: true,
    params: [
      {
        key: "criterion",
        label: "Keep items that…",
        type: "textarea",
        default: FILTER_CUSTOMER_CRITERION,
        placeholder: "…are customer-facing, not regulation, engineering specs or pricing.",
      },
      { key: "include", label: "Include criteria", type: "textarea", default: "" },
      { key: "exclude", label: "Exclude criteria", type: "textarea", default: "" },
      {
        key: "examples",
        label: "Labelled examples (guidance, not evidence)",
        type: "textarea",
        default: "",
      },
      {
        key: "fields",
        label: "Fields to assess (comma-separated; blank = all)",
        type: "text",
        default: "",
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
    description: "Analyzes raw data into customer-priority bands, car parts or custom groups.",
    group: "ai",
    hasInnerWorkplace: true,
    params: [
      {
        key: "splitBy",
        label: "Split by",
        type: "select",
        default: "customer_priority",
        options: [
          { value: "customer_priority", label: "Customer priority (raw feedback)" },
          { value: "car_parts", label: "Car parts (choose depth)" },
          { value: "priority", label: "Priority" },
          { value: "category", label: "Requirement category" },
          { value: "sentiment", label: "Sentiment" },
          { value: "custom", label: "Custom instruction" },
        ],
      },
      {
        key: "partDepth",
        label: "Depth",
        help: "How finely the car is divided. The outputs follow: one per area or part group, plus Other.",
        type: "select",
        default: "areas",
        options: CarPartDepth.options.map((value) => ({
          value,
          label: CAR_PART_DEPTH_LABELS[value],
        })),
        visibleWhen: { key: "splitBy", equals: "car_parts" },
      },
      {
        key: "branches",
        label: "Branches (one output each)",
        type: "list",
        default: ["High", "Medium", "Low"],
        minItems: 2,
        maxItems: 10,
        itemPlaceholder: "Branch name",
        visibleWhen: { key: "splitBy", notEquals: "car_parts" },
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
    ports: (params) => ({
      inputs: [IN],
      outputs: splitterOutputLabels(params).map((label, i) => ({ id: `out-${i}`, label })),
    }),
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
      "AI agents turn what arrives into requirements for the next car. 1. Priority matters most; context inputs give background.",
    group: "output",
    hasInnerWorkplace: false,
    params: [
      {
        key: "priorities",
        label: "Priority inputs",
        type: "number",
        default: 3,
        min: 1,
        max: MAX_PRIORITY_INPUTS,
        help: "One input per priority. 1. Priority is the most important: the input an item arrives on sets its ranking.",
      },
      {
        key: "contexts",
        label: "Context inputs",
        type: "list",
        default: ["auto"],
        minItems: 0,
        maxItems: MAX_CONTEXT_INPUTS,
        itemPlaceholder: "Context",
        itemOptions: CONTEXT_MODE_OPTIONS,
        help: "Background the agents use but don't turn into requirements. Auto: the agents work out what the data is.",
      },
      {
        key: "maxRequirements",
        label: "Max. requirements",
        type: "number",
        default: 20,
        min: 1,
        max: 60,
        help: "Per run. The strongest themes become requirements; the rest are listed as held back.",
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
    ],
    ports: (params) => {
      const { priorities, contexts } = addToCarInputs(params);
      return {
        inputs: [
          ...priorities.map(({ port, label }) => ({ id: port, label })),
          ...contexts.map(({ port, label }) => ({ id: port, label })),
        ],
        outputs: [],
      };
    },
  },
  analytics: {
    kind: "analytics",
    label: "Analytics",
    description:
      "Counts what the data says by country, time and topic, and compares its inputs. Rules only, no AI.",
    group: "insight",
    hasInnerWorkplace: false,
    params: [
      {
        key: "inputs",
        label: "Inputs (one port each)",
        type: "list",
        default: ["Input 1"],
        minItems: 1,
        maxItems: MAX_ANALYTICS_INPUTS,
        itemPlaceholder: "Input name",
        help: "Each input is a data source. Name them to tell them apart when you compare them.",
      },
      {
        key: "countryColumn",
        label: "Country column",
        type: "text",
        default: "",
        placeholder: "Auto (Country, Market, Land, …)",
        help: "Leave empty to detect it. Records without one fall back to their market.",
      },
      {
        key: "timeColumn",
        label: "Time column",
        type: "text",
        default: "",
        placeholder: "Auto (Date, Created, Month, Year, …)",
        help: "Leave empty to detect it. Without a time column the timeline stays empty.",
      },
      {
        key: "timeGranularity",
        label: "Timeline buckets",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto" },
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
          { value: "month", label: "Month" },
          { value: "quarter", label: "Quarter" },
          { value: "year", label: "Year" },
        ],
      },
      {
        key: "phrases",
        label: "Tracked phrases",
        type: "textarea",
        default: "",
        placeholder: "seat comfort\nnoise\nnavigation",
        help: "One per line. The analytics view counts how many records and people say each one.",
      },
    ],
    ports: (params) => ({
      inputs: analyticsInputs(params),
      outputs: [{ id: "out", label: "All inputs" }],
    }),
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
        .array(
          spec.itemOptions
            ? z.enum(spec.itemOptions.map((o) => o.value) as [string, ...string[]])
            : z.string().trim().min(1, "Entries can't be empty").max(60),
        )
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

/**
 * Params saved by older builds, brought up to date so they validate. Add to Car's
 * named rankings ("Must have", …) became numbered priority inputs on the same ports (`in-0`, …),
 * and context inputs were added. The AI Splitter gained `partDepth`, Raw `marketFilter` and `columns`.
 * Anything else is returned unchanged, so validation still reports it.
 */
export function migrateBlockParams(kind: BlockKind, params: BlockParams): BlockParams {
  if (kind === "ai_filter") return { ...defaultBlockParams("ai_filter"), ...params };
  // Raw gained a market filter and a column mapping; older flows keep every market, as before.
  if (kind === "raw" && !("marketFilter" in params && "columns" in params))
    return { marketFilter: "all", columns: "", ...params };
  // The AI Splitter gained a car-part depth; older flows split by AI-chosen groups get areas.
  if (kind === "ai_splitter" && !("partDepth" in params)) return { ...params, partDepth: "areas" };
  if (kind !== "add_to_car" || !("rankings" in params)) return params;
  const { rankings, mergeDuplicates: _merged, ...rest } = params;
  const count = Array.isArray(rankings) ? rankings.length : 3;
  return {
    ...defaultBlockParams("add_to_car"),
    ...rest,
    priorities: Math.max(1, Math.min(MAX_PRIORITY_INPUTS, count)),
    contexts: [], // older flows had no context inputs: keep their wiring exactly as it was
  };
}

/** Throws a ZodError naming the bad field. */
export function parseBlockParams(kind: BlockKind, params: unknown): BlockParams {
  return blockParamsSchema(kind).parse(params);
}

/** Whether a param field is shown, given the block's current params. */
export function isParamVisible(spec: ParamSpec, params: BlockParams): boolean {
  const when = spec.visibleWhen;
  if (!when) return true;
  return "equals" in when ? params[when.key] === when.equals : params[when.key] !== when.notEquals;
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
