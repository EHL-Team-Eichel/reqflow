import { describe, expect, it } from "vitest";
import { createSetupClient, createJudgeClient } from "./setup-client";

describe("setup-client", () => {
  it("provider switch, missing key, jev rejected as writer", () => {
    expect(() =>
      createSetupClient(
        {
          provider: "jev",
          id: "j",
          name: "Jev",
          baseUrl: "",
          model: "",
          fastModel: "m",
          effort: "low",
          temperature: 0,
          maxParallel: 1,
        },
        {},
      ),
    ).toThrow(/can only be the judge/);

    expect(() =>
      createSetupClient(
        {
          provider: "anthropic",
          id: "a",
          name: "Anth",
          baseUrl: "",
          model: "m",
          fastModel: "m",
          effort: "low",
          temperature: 0,
          maxParallel: 1,
        },
        {},
      ),
    ).toThrow(/has no API key/);

    const client = createSetupClient(
      {
        provider: "mock",
        id: "m",
        name: "Mock",
        baseUrl: "",
        model: "m",
        fastModel: "m",
        effort: "low",
        temperature: 0,
        maxParallel: 1,
      },
      {},
    );
    expect(client).toBeDefined();

    const judge = createJudgeClient(
      {
        provider: "jev",
        id: "j",
        name: "Jev",
        baseUrl: "https://api.typesafe.ai/v1",
        model: "jev-latest",
        fastModel: "m",
        effort: "low",
        temperature: 0,
        maxParallel: 1,
      },
      { apiKey: "key" },
    );
    expect(judge).toBeDefined();
  });
});
