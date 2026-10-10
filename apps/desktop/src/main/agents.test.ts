import { DEFAULT_SETTINGS, type ApiSetup, type LlmClient, type Settings } from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentServices, testSetup, type AgentDeps } from "./agents";

const claude: ApiSetup = {
  id: "claude",
  name: "Team Claude",
  provider: "anthropic",
  baseUrl: "",
  model: "claude-opus-5-5",
  fastModel: "claude-haiku-5-5",
  effort: "high",
  temperature: 0.2,
  maxParallel: 2,
};
const jev: ApiSetup = {
  ...claude,
  id: "jev",
  name: "Jev",
  provider: "jev",
  model: "jev-latest",
  fastModel: "",
};

function settings(
  roles: Partial<Settings["agents"]["roles"]> = {},
  setups = [claude, jev],
): Settings {
  return {
    ...DEFAULT_SETTINGS,
    llm: { ...DEFAULT_SETTINGS.llm, provider: "anthropic" },
    agents: { setups, roles: { ...DEFAULT_SETTINGS.agents.roles, ...roles } },
  };
}

function deps(
  o: { keys?: Record<string, string>; fetch?: typeof fetch; seen?: unknown[] } = {},
): AgentDeps {
  const fake: LlmClient = {
    generateObject: async (r) => {
      o.seen?.push(r);
      return {
        object: r.schema.parse({ answers: { support: { probability: 0.8 } } }),
        model: "default-model",
      };
    },
    generateText: async (r) => {
      o.seen?.push(r);
      return { text: "OK", model: "default-model" };
    },
  };
  return {
    defaultLlm: async () => fake,
    getKey: async (id) => o.keys?.[id] ?? null,
    fetch: o.fetch,
  };
}

const claudeAnswer = () =>
  new Response(
    JSON.stringify({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"ok":true}' }],
    }),
  );

describe("agent services", () => {
  it("uses the default AI where no setup is assigned, thinking at medium unless told otherwise", async () => {
    const seen: any[] = [];
    const services = createAgentServices(settings(), deps({ seen }));
    const { info, llm } = await services.writer("architect");
    expect(info).toMatchObject({
      setupId: "default",
      setupName: "Default AI",
      provider: "anthropic",
    });
    await llm.generateObject({ prompt: "p", schema: z.object({ answers: z.any() }) });
    await llm.generateObject({
      prompt: "p",
      schema: z.object({ answers: z.any() }),
      effort: "off",
    });
    expect(seen.map((r) => r.effort)).toEqual(["medium", "off"]);
  });

  it("builds a role's client from its setup and key, sharing the setup's limiter", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => claudeAnswer());
    const services = createAgentServices(
      settings({ architect: "claude", critic: "claude" }),
      deps({ keys: { claude: "sk-test" }, fetch }),
    );
    const architect = await services.writer("architect");
    expect(architect.info).toMatchObject({
      setupId: "claude",
      setupName: "Team Claude",
      maxParallel: 2,
    });
    await architect.llm.generateObject({ prompt: "p", schema: z.object({ ok: z.boolean() }) });
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(sent.output_config.effort).toBe("high"); // the setup's own effort
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)["x-api-key"]).toBe(
      "sk-test",
    );
  });

  it("explains what's wrong instead of failing later", async () => {
    const noKey = createAgentServices(settings({ analyst: "claude" }), deps());
    await expect(noKey.writer("analyst")).rejects.toThrow(
      'API setup "Team Claude" has no API key. Add it in Settings → AI.',
    );
    const judgeOnly = createAgentServices(
      settings({ critic: "jev" }),
      deps({ keys: { jev: "k" } }),
    );
    await expect(judgeOnly.writer("critic")).rejects.toThrow(/can only be the judge/);
    const gone = createAgentServices(settings({ synthesizer: "deleted" }), deps());
    await expect(gone.writer("synthesizer")).rejects.toThrow(/no longer exists/);
  });

  it("lets TypeSafe Jev judge, and an LLM judge otherwise", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { support: { type: "noul", noul: 0.7 } },
          }),
        ),
    );
    const viaJev = await createAgentServices(
      settings({ judge: "jev" }),
      deps({ keys: { jev: "k" }, fetch }),
    ).judge();
    const res = await viaJev.decisions.decide({
      state: "s",
      questions: { support: { type: "noul", instructions: "i" } },
    });
    expect(res).toMatchObject({
      model: "jev-1.13.0",
      answers: { support: { type: "noul", value: 0.7 } },
    });
    expect(viaJev.info.provider).toBe("jev");

    const viaLlm = await createAgentServices(settings(), deps()).judge();
    const llmRes = await viaLlm.decisions.decide({
      state: "s",
      questions: { support: { type: "noul", instructions: "i" } },
    });
    expect(llmRes.answers.support).toEqual({ type: "noul", value: 0.8 });
  });
});

describe("testing an API setup", () => {
  it("reports success with the model and time, and failures in safe words", async () => {
    const ok = await testSetup(settings(), "default", deps());
    expect(ok).toMatchObject({ ok: true, model: "default-model" });
    expect(ok.message).toMatch(/^Connected: default-model answered in \d+ ms\.$/);

    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "bad key sk-xyz" },
          }),
          {
            status: 401,
          },
        ),
    );
    const denied = await testSetup(
      settings(),
      "claude",
      deps({ keys: { claude: "sk-xyz" }, fetch }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.message).toBe("Anthropic request failed (HTTP 401, authentication_error)");

    expect(
      await testSetup(
        settings([] as never, [{ ...claude, id: "m", provider: "mock" }]),
        "m",
        deps(),
      ),
    ).toMatchObject({
      ok: true,
      model: "offline",
    });
    expect((await testSetup(settings(), "missing", deps())).ok).toBe(false);
    expect((await testSetup(settings(), "claude", deps())).message).toMatch(/no API key/);
  });
});
