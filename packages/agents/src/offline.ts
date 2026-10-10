import type { JudgingAgents } from "@reqflow/core";

/** Explicit offline demonstration only. It never claims to have performed an independent review. */
export function createOfflineJudgingAgents(): JudgingAgents {
  return {
    model: "mock/judge (offline demonstration, no model calls)",
    async resolveScope(prompt) {
      const query = /Query: "([^"]+)"/.exec(prompt)?.[1]?.toLowerCase() ?? "";
      const entries = [
        ...(prompt.split("Aspects (id: label):")[0] ?? prompt).matchAll(/^- ([a-z_]+): (.+)$/gm),
      ];
      if (query.startsWith("all customer-facing vehicle components"))
        return {
          interpretation: "Offline demonstration across supplied customer-facing topics",
          core: entries.map(([, id]) => ({
            component: id!,
            aspect: null,
            reason: "Explicit all-component scope",
          })),
          adjacent: [],
        };
      const component = entries.find(
        ([, id, label]) =>
          query.includes(id!.replaceAll("_", " ")) ||
          label!
            .toLowerCase()
            .split(/[^a-z]+/)
            .some((word) => word.length > 3 && query.includes(word)),
      );
      if (!component) throw new Error("Offline scope resolver needs a named component, e.g. seats");
      return {
        interpretation: `Offline demonstration of ${query}`,
        core: [
          { component: component[1]!, aspect: null, reason: "Explicit offline keyword match" },
        ],
        adjacent: [],
      };
    },
    async research() {
      return { items: [], searchNotes: "Offline demonstration: no web research performed" };
    },
    async proposeActions(prompt) {
      const refs = [...new Set([...prompt.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]!))];
      const problem = /Problem: ([^\n]+)/.exec(prompt)?.[1] ?? "the reported customer problem";
      return {
        actions: [
          {
            title: `Investigate ${problem}`,
            type: "investigate",
            description: `Review the linked evidence for ${problem} and validate the problem before selecting a remedy. This is an offline demonstration, not an AI-generated solution.`,
            acceptanceCriteria: [
              "A human reviewer records the confirmed problem and the next validation step.",
            ],
            addresses: refs,
            rationale: "Offline demonstration based only on the supplied references",
            assumptions: ["No live model or independent confidence judge was used."],
            risks: ["A specific remedy has not been validated."],
          },
        ],
      };
    },
    async judge() {
      return {
        quoteChecks: [],
        solutionSupport: "none",
        solutionReasoning: "Not assessed: offline demonstration",
        whyNotHigher: ["No independent confidence assessment was performed."],
        toRaiseIt: ["Run the configured live agents and validate the supporting evidence."],
      };
    },
  };
}
