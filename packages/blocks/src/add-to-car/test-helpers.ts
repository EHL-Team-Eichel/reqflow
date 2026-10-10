import {
  DEFAULT_SETTINGS,
  emptyPipelineData,
  type AgentModel,
  type AgentServices,
  type AuditEventInput,
  type DecisionClient,
  type LlmClient,
  type PipelineData,
  type ReasoningTrace,
  type Requirement,
  type SourceKind,
} from "@reqflow/core";
import type { BlockContext, CarEvidence } from "@reqflow/engine";

/** Synthetic test data only (AGENTS.md rule 3): invented comments, never BMW data. */
export function dataset(
  key: string,
  kind: SourceKind,
  rows: { text: string; market?: string; fields?: Record<string, unknown> }[],
): PipelineData {
  const sourceId = `src_${key}`;
  return {
    ...emptyPipelineData(),
    sources: [
      {
        id: sourceId,
        kind,
        origin: "bmw_internal",
        title: `${key}.csv`,
        retrievedAt: "2026-10-10T00:00:00.000Z",
        reliability: "high",
      },
    ],
    records: rows.map((r, i) => ({
      id: `rec_${key}_${i + 1}`,
      sourceId,
      text: r.text,
      locator: `row ${i + 2}`,
      ...(r.market ? { market: r.market } : {}),
      ...(r.fields ? { fields: r.fields } : {}),
    })),
  };
}

export const model = (provider: AgentModel["provider"], name: string = provider): AgentModel => ({
  setupId: "default",
  setupName: "Test setup",
  provider,
  model: name,
  fastModel: name,
  maxParallel: 3,
});

export function agents(o: {
  llm?: LlmClient;
  decisions?: DecisionClient;
  provider?: AgentModel["provider"];
  failWriter?: string;
}): AgentServices {
  const provider = o.provider ?? "mock";
  const unused: LlmClient = {
    generateObject: async () => {
      throw new Error("not used");
    },
    generateText: async () => {
      throw new Error("not used");
    },
  };
  return {
    async writer() {
      if (o.failWriter) throw new Error(o.failWriter);
      return {
        info: model(provider, provider === "mock" ? "mock" : "test-model"),
        llm: o.llm ?? unused,
      };
    },
    async judge() {
      return {
        info: model(provider, provider === "mock" ? "mock" : "test-judge"),
        decisions: o.decisions ?? { decide: async () => ({ answers: {}, model: "x" }) },
      };
    },
  };
}

export interface Captured {
  ctx: BlockContext;
  audit: AuditEventInput[];
  added: { requirements: Requirement[]; evidence?: CarEvidence }[];
  traces: ReasoningTrace[];
  logs: string[];
  abort: AbortController;
}

export function context(services: AgentServices, firstSeq = 1): Captured {
  const audit: AuditEventInput[] = [];
  const added: Captured["added"] = [];
  const traces: ReasoningTrace[] = [];
  const logs: string[] = [];
  const abort = new AbortController();
  const ctx: BlockContext = {
    runId: "run_test",
    blockId: "car",
    scope: DEFAULT_SETTINGS.defaultScope,
    settings: DEFAULT_SETTINGS,
    llm: services as never,
    agents: services,
    audit: {
      record: async (e) => {
        audit.push(e);
        return {
          ...e,
          id: `aud_${audit.length}`,
          at: new Date().toISOString(),
          changes: e.changes ?? [],
        };
      },
    },
    files: { get: async () => Promise.reject(new Error("no files")) },
    web: null,
    car: {
      add: async (requirements, evidence) => void added.push({ requirements, evidence }),
      nextSeq: async () => firstSeq,
      saveReasoning: async (t) => void traces.push(t),
    },
    log: (m) => void logs.push(m),
    progress: () => {},
    signal: abort.signal,
    resumed: false,
  };
  return { ctx, audit, added, traces, logs, abort };
}

/** An LLM that answers each Add to Car contract with `answer(contract, payload)`. */
export function scriptedLlm(
  answer: (contract: string, payload: Record<string, any>) => unknown,
  calls: string[] = [],
): LlmClient {
  return {
    async generateObject(request) {
      request.signal?.throwIfAborted();
      const payload = JSON.parse(request.prompt) as Record<string, any>;
      calls.push(payload.contract);
      const object = request.schema.parse(await answer(payload.contract, payload));
      return {
        object,
        model: "test-model",
        usage: { inputTokens: 100, outputTokens: 10 },
        ...(payload.contract.includes("architect")
          ? { thinking: "Weighed knee room against boot space." }
          : {}),
      };
    },
    generateText: async () => {
      throw new Error("not used");
    },
  };
}
