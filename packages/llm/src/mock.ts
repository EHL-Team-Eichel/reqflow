import { CATEGORY_LABELS, ScoreFactor } from "@reqflow/core";
import { z } from "zod";

const Item = z.object({
  id: z.string().min(1),
  layer: z.enum(["requirements", "themes", "findings", "records"]),
  item: z.record(z.string(), z.unknown()),
  context: z
    .object({ findings: z.array(z.record(z.string(), z.unknown())).default([]) })
    .passthrough(),
});
const Payload = z
  .object({
    contract: z.enum(["reqflow.ai-splitter.routing@1", "reqflow.ai-splitter.scoring@1"]),
    mode: z.enum(["category", "sentiment", "custom", "priority"]),
    branches: z.array(z.string().min(1)).min(2).max(10),
    instruction: z.string(),
    items: z.array(Item).min(1).max(20),
  })
  .passthrough();

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stableIndex(id: string, size: number): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % size;
}

/** Deliberately narrow offline protocol, not a generic schema synthesis engine. */
export function mockObject(prompt: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(prompt);
  } catch {
    throw new Error(
      "Unsupported prompt for mock provider; expected explicit AI Splitter JSON contract.",
    );
  }
  const checked = Payload.safeParse(raw);
  if (!checked.success) {
    throw new Error(
      "Unsupported prompt for mock provider; expected explicit AI Splitter JSON contract.",
    );
  }
  const payload = checked.data;
  if (payload.contract === "reqflow.ai-splitter.scoring@1") {
    if (payload.mode !== "priority")
      throw new Error("Mock scoring contract requires priority mode");
    return {
      scores: payload.items.map(({ id }) => ({
        id,
        factors: Object.fromEntries(
          ScoreFactor.options.map((factor) => [
            factor,
            {
              value: 2,
              note: `MOCK assumption: ${factor} fixed at 2/5 for offline routing; not measured evidence.`,
            },
          ]),
        ),
      })),
    };
  }
  if (payload.mode === "priority") throw new Error("Mock routing contract does not score priority");
  return {
    assignments: payload.items.map(({ id, item, context }) => {
      const labels = payload.branches.map(normalized);
      const text = normalized(
        [item.text, item.title, item.description, item.statement, item.summary, item.label]
          .filter((v): v is string => typeof v === "string")
          .join(" "),
      );
      let index = -1;
      let rule = "label keyword match";
      if (payload.mode === "category" && typeof item.category === "string") {
        const category = normalized(item.category);
        const title = normalized(
          CATEGORY_LABELS[item.category as keyof typeof CATEGORY_LABELS] ?? item.category,
        );
        index = labels.findIndex(
          (label) =>
            label === category || label === title || (label.length > 2 && title.includes(label)),
        );
        rule = "existing category match";
      } else if (payload.mode === "sentiment") {
        const values = [item, ...context.findings]
          .map((f) => f.sentiment)
          .filter((v): v is number => typeof v === "number");
        const value = values.length
          ? values.reduce((sum, v) => sum + v, 0) / values.length
          : /\b(love|great|excellent|praise)\b/.test(text)
            ? 1
            : /\b(fail|fails|cheap|complain|complaint|poor|bad)\b/.test(text)
              ? -1
              : 0;
        const band = value > 0.2 ? "positive" : value < -0.2 ? "negative" : "neutral";
        index = labels.findIndex((label) => label.includes(band));
        rule = values.length
          ? "existing sentiment mean"
          : "synthetic keyword sentiment rule (not inference)";
      }
      if (index < 0) index = labels.findIndex((label) => label.length > 1 && text.includes(label));
      if (index < 0) {
        index = stableIndex(id, labels.length);
        rule = "stable ID fallback, not semantic assessment";
      }
      return { id, branchIndex: index, reason: `MOCK routing: ${rule}.` };
    }),
  };
}
