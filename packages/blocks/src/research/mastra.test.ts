import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Agent, type AgentExecutionOptions } from "@mastra/core/agent";
import { RESEARCH_AGENT_IDS, ResearchScope, type ResearchAgentId } from "@reqflow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQueries } from "./agents";
import { createMastraQueryPlanner, createMastraResearchAgents } from "./mastra";

const options = { apiKey: "synthetic-injected-key", modelId: "claude-haiku-4-5" };
const scope = ResearchScope.parse({
  currentGeneration: "G60",
  previousGeneration: "G30",
  derivative: "Sedan",
  propulsion: "BEV",
  modelYear: "2026",
  markets: ["EU", "China"],
  languages: ["en", "de"],
  publishedFrom: "2024-01-01",
  publishedTo: "2026-10-10",
  questions: ["How is cabin space described?"],
  keywords: ["charging"],
  competitors: [{ brand: "Mercedes-Benz", model: "E-Class", generation: "W214" }],
  urls: ["https://example.org/private-source"],
  documentIds: ["file_private"],
});

// The final generate overload omits options. Narrow its test view to the exercised overload.
type GenerateWithOptions = (
  prompt: Parameters<Agent["generate"]>[0],
  execution?: AgentExecutionOptions<{ queries: string[] }>,
) => ReturnType<Agent["generate"]>;
const agentPrototype = Agent.prototype as unknown as { generate: GenerateWithOptions };

// Stub only the paid method. Constructors, model configuration and schemas remain real.
function mockOutput(object: unknown) {
  return vi
    .spyOn(agentPrototype, "generate")
    .mockResolvedValue({ object } as Awaited<ReturnType<Agent["generate"]>>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createMastraResearchAgents", () => {
  it("constructs all 13 real, isolated, tool-free Mastra Agents with direct Anthropic credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-env-key-not-selected");
    const fetch = vi.spyOn(globalThis, "fetch");
    const agents = createMastraResearchAgents(options);
    expect(Object.keys(agents)).toEqual([...RESEARCH_AGENT_IDS]);
    expect(new Set(Object.values(agents)).size).toBe(13);
    for (const id of RESEARCH_AGENT_IDS) {
      const agent = agents[id];
      expect(agent).toBeInstanceOf(Agent);
      expect(agent.id).toBe(id);
      expect(await agent.getMemory()).toBeUndefined();
      expect(agent.getMastraInstance()).toBeUndefined();
      expect(await agent.listTools()).toEqual({});
      expect(await agent.listErrorProcessors()).toEqual([]);
      const instructions = await agent.getInstructions();
      expect(instructions).toMatch(/query planning only/i);
      expect(instructions).toMatch(/no source content/i);
      expect(instructions).toMatch(/never infer.*country/i);
      expect(instructions).not.toContain(options.apiKey);
      const model = await agent.getModel();
      expect(model.modelId).toBe(options.modelId);
      expect(model.provider).toContain("anthropic");
      // Inspect configuration without snapshotting or logging the credential.
      expect(
        (model as unknown as { config: { apiKey: string } }).config.apiKey === options.apiKey,
      ).toBe(true);
      expect(await agent.getDefaultOptions()).toMatchObject({
        maxSteps: 1,
        toolChoice: "none",
        activeTools: [],
        maxProcessorRetries: 0,
        tracingOptions: { hideInput: true, hideOutput: true },
        modelSettings: { maxRetries: 0, maxOutputTokens: 768, temperature: 0 },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts explicit Anthropic router IDs, rejects blank keys and non-Anthropic routing without env fallback", () => {
    expect(
      createMastraResearchAgents({ ...options, modelId: `anthropic/${options.modelId}` }).reddit,
    ).toBeInstanceOf(Agent);
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-env-key-not-selected");
    expect(() => createMastraResearchAgents({ ...options, apiKey: "" })).toThrow();
    expect(() => createMastraResearchAgents({ ...options, apiKey: "   " })).toThrow();
    expect(() => createMastraQueryPlanner({ ...options, modelId: "" })).toThrow();
    expect(() => createMastraResearchAgents({ ...options, modelId: "openai/gpt-4" })).toThrow(
      /Anthropic|anthropic/,
    );
  });

  it("has no environment, secrets, source adapters or orchestration dependencies", () => {
    const source = readFileSync(fileURLToPath(new URL("./mastra.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(
      /process\s*\.\s*env|node:fs|node:http|from ["']\.\/providers|new Mastra\(|createWorkflow\(/,
    );
  });
});

describe("createMastraQueryPlanner", () => {
  it.each(RESEARCH_AGENT_IDS)(
    "calls the selected real %s Agent once and preserves its deterministic root",
    async (id) => {
      const generate = mockOutput({ queries: [buildQueries(id, scope)[0]] });
      const controller = new AbortController();
      const result = await createMastraQueryPlanner(options)(id, scope, controller.signal);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.contexts[0]).toBeInstanceOf(Agent);
      expect((generate.mock.contexts[0] as Agent).id).toBe(id);
      expect(result[0]).toBe(buildQueries(id, scope)[0]);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);
      const [prompt, execution] = generate.mock.calls[0]!;
      expect(typeof prompt).toBe("string");
      expect(prompt).toContain("G60");
      expect(prompt).toContain("G30");
      expect(prompt).toContain("China");
      expect(prompt).toContain("2024-01-01");
      expect(prompt).toContain('"languages":["en","de"]');
      expect(prompt).not.toContain(options.apiKey);
      expect(prompt).not.toContain("private-source");
      expect(prompt).not.toContain("file_private");
      expect(execution).toMatchObject({
        abortSignal: controller.signal,
        maxSteps: 1,
        toolChoice: "none",
        activeTools: [],
        maxProcessorRetries: 0,
        structuredOutput: { errorStrategy: "strict" },
        modelSettings: { maxOutputTokens: 768, maxRetries: 0, temperature: 0 },
        tracingOptions: { hideInput: true, hideOutput: true },
      });
      expect(execution).not.toHaveProperty("memory");
      expect(execution?.structuredOutput).not.toHaveProperty("model");
      const schema = execution!.structuredOutput.schema;
      expect(
        await schema["~standard"].validate({ queries: ["BMW 5 Series cabin space"] }),
      ).toMatchObject({
        value: { queries: ["BMW 5 Series cabin space"] },
      });
      expect(
        await schema["~standard"].validate({ queries: ["search"], sentiment: "negative" }),
      ).toHaveProperty("issues");
    },
  );

  it("keeps a neutral deterministic query and roots natural-phrased suggestions without source interpretation", async () => {
    mockOutput({
      queries: ["How is rear seat space described?", "charging equipment", "cabin dimensions"],
    });
    const result = await createMastraQueryPlanner(options)(
      "editorial_reviews",
      scope,
      new AbortController().signal,
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(buildQueries("editorial_reviews", scope)[0]);
    for (const query of result) {
      expect(query).toMatch(/^BMW 5 Series/);
      expect(query).toContain("G60");
      expect(query).toContain("G30");
      expect(query).toContain("market context EU China");
      expect(query.length).toBeLessThanOrEqual(500);
    }
    expect(result[1]).toContain("How is rear seat space described?");
  });

  it.each(["bmw_sales", "bmw_strategy", "competitor_models"] as const)(
    "preserves %s expert constraints in every suggested query",
    async (id) => {
      mockOutput({ queries: ["published tables", "equipment descriptions"] });
      const result = await createMastraQueryPlanner(options)(
        id,
        scope,
        new AbortController().signal,
      );
      for (const query of result) {
        expect(query.startsWith(buildQueries(id, scope)[0]!)).toBe(true);
        if (id === "competitor_models") expect(query).toContain("Mercedes-Benz E-Class W214");
        else {
          expect(query).toContain("site:bmwgroup.com");
          expect(query).toContain("site:press.bmwgroup.com");
        }
      }
    },
  );

  it("validates even suggestions beyond the retained two slots", async () => {
    mockOutput({
      queries: ["cabin dimensions", "charging equipment", "owners are dissatisfied with seats"],
    });
    await expect(
      createMastraQueryPlanner(options)("reddit", scope, new AbortController().signal),
    ).rejects.toThrow(/interpretation/i);
  });

  it("propagates explicit Mastra result errors even if an object was returned", async () => {
    const error = new Error("synthetic structured output failure");
    const generate = vi.spyOn(agentPrototype, "generate").mockResolvedValue({
      object: { queries: ["cabin dimensions"] },
      error,
    } as Awaited<ReturnType<Agent["generate"]>>);
    await expect(
      createMastraQueryPlanner(options)("reddit", scope, new AbortController().signal),
    ).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    {},
    { queries: [] },
    { queries: ["a", "b", "c", "d"] },
    { queries: [""] },
    { queries: [" "] },
    { queries: ["x".repeat(501)] },
    { queries: ["search"], evidence: [] },
    { queries: ["search"], sentiment: "negative" },
    { queries: ["search"], recommendations: [] },
    { queries: ["BMW 5 Series owners are dissatisfied with seats"] },
    { queries: ["BMW should improve charging"] },
    { queries: ['BMW 5 Series "invented source quote"'] },
  ])(
    "explicitly rejects invalid or interpretive output %# without model retries",
    async (output) => {
      const generate = mockOutput(output);
      await expect(
        createMastraQueryPlanner(options)("reddit", scope, new AbortController().signal),
      ).rejects.toThrow();
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects suggestions which cannot fit alongside the preserved scope root", async () => {
    mockOutput({ queries: ["x".repeat(499)] });
    await expect(
      createMastraQueryPlanner(options)("reddit", scope, new AbortController().signal),
    ).rejects.toThrow(/500|too long|length/i);
  });

  it("rejects extra source content at the scope boundary before any model call", async () => {
    const generate = mockOutput({ queries: ["search"] });
    await expect(
      createMastraQueryPlanner(options)(
        "reddit",
        { ...scope, sourceText: "private original feedback" } as ResearchScope,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not call generate for an already aborted signal or invalid agent", async () => {
    const generate = mockOutput({ queries: ["search"] });
    const controller = new AbortController();
    controller.abort();
    const planner = createMastraQueryPlanner(options);
    await expect(planner("reddit", scope, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      planner("unknown" as ResearchAgentId, scope, new AbortController().signal),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it("forwards cancellation and refuses late output after an in-flight abort", async () => {
    const controller = new AbortController();
    const generate = vi
      .spyOn(agentPrototype, "generate")
      .mockImplementation(async (_prompt, execution) => {
        expect(execution?.abortSignal).toBe(controller.signal);
        controller.abort();
        return { object: { queries: ["cabin space"] } } as Awaited<ReturnType<Agent["generate"]>>;
      });
    await expect(
      createMastraQueryPlanner(options)("reddit", scope, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("propagates provider errors without silent deterministic fallback or paid retries", async () => {
    const error = new Error("synthetic rate limit");
    const generate = vi.spyOn(agentPrototype, "generate").mockRejectedValue(error);
    await expect(
      createMastraQueryPlanner(options)("reddit", scope, new AbortController().signal),
    ).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
