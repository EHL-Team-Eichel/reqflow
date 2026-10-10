/**
 * Registry keys of every planned node. This list is part of the contract: the default template,
 * the editor and the implementations all refer to these names. Add new types here first.
 */
export const NODE_TYPES = {
  bmwDataset: "source.bmw_dataset", // WS5 — ingest one BMW-provided file
  webResearch: "source.web_research", // WS6 — competitors, reviews, trends from the web
  extractSignals: "analysis.extract_signals", // WS7 — records → evidence-linked findings
  scopeFilter: "analysis.scope_filter", // WS7 — drop regulatory / engineering / pricing items
  clusterThemes: "analysis.cluster_themes", // WS7 — dedupe + group findings into themes
  deriveRequirements: "requirements.derive", // WS7 — themes → requirement drafts
  specifyTargets: "requirements.specify_targets", // WS7 — measurable targets, evidence level, assumptions
  score: "prioritization.score", // WS8 — explainable weighted score + priority
  pmGate: "review.pm_gate", // WS1 — pause until the PM has reviewed
  publish: "output.publish", // WS1 — persist to the Requirements page
  export: "output.export", // WS1 — JSON / CSV / Markdown export
} as const;

export type NodeType = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];
export const ALL_NODE_TYPES: readonly string[] = Object.values(NODE_TYPES);
