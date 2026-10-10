import type { Plugin } from "@opencode-ai/plugin";

// File-defined global agents can override inline project defaults. Apply the
// requested policy after configuration merging without replacing their prompts
// or permissions, or changing the primary build/plan agent.
const roles = new Map<string, "low" | "medium" | "high">([
  ["explore", "low"],
  ["technical-writer", "low"],
  ["general", "medium"],
  ["test-writer", "medium"],
  ["fullstack-developer", "high"],
  ["debugger", "high"],
  ["code-reviewer", "high"],
  ["security-auditor", "high"],
]);

export const GeminiSubagents: Plugin = async () => ({
  config(config) {
    for (const [name, agent] of Object.entries(config.agent ?? {})) {
      if (agent.disable || !(roles.has(name) || agent.mode === "subagent" || agent.mode === "all"))
        continue;
      agent.model = "google/gemini-3.8-flash";
      agent.variant =
        roles.get(name) ??
        (["low", "medium", "high"].includes(agent.variant ?? "") ? agent.variant : "medium");
    }
  },
});
