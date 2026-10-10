import { ReasoningEffort, type LlmClient } from "@reqflow/core";
import { z } from "zod";
import { Limiter, LlmHttpError, postJson } from "./http";

export function openAiStrictSchema(schema: any): any {
  const walk = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);

    const out: any = { ...node };
    delete out.$schema;

    const constraints: string[] = [];
    const moveConstraint = (key: string, name = key) => {
      if (out[key] !== undefined) {
        if (key === "format" && ["date-time", "date", "email", "uri", "uuid"].includes(out[key])) {
          return;
        }
        if (key === "minItems" && out[key] <= 1) {
          return;
        }
        constraints.push(`${name}: ${out[key]}`);
        delete out[key];
      }
    };

    moveConstraint("minLength");
    moveConstraint("maxLength");
    moveConstraint("pattern");
    moveConstraint("minimum");
    moveConstraint("maximum");
    moveConstraint("exclusiveMinimum");
    moveConstraint("exclusiveMaximum");
    moveConstraint("multipleOf");
    moveConstraint("minItems");
    moveConstraint("maxItems");
    moveConstraint("uniqueItems");
    moveConstraint("format");

    if (constraints.length) {
      out.description = [
        out.description,
        `Local validation constraints: {${constraints.join(", ")}}.`,
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (out.type === "object" || out.properties) {
      out.additionalProperties = false;
      const props = out.properties || {};
      const origRequired = out.required || [];
      const newRequired = Object.keys(props);
      if (newRequired.length) {
        out.required = newRequired;
      }
      out.properties = {};
      for (const [k, v] of Object.entries(props)) {
        let child = walk(v);
        if (!origRequired.includes(k)) {
          child = { anyOf: [child, { type: "null" }] };
        }
        out.properties[k] = child;
      }
    } else if (out.items) {
      out.items = walk(out.items);
    } else if (out.anyOf) {
      out.anyOf = out.anyOf.map(walk);
    }
    return out;
  };
  return walk(schema);
}

function stripOptionalNulls(data: any, origSchema: any): any {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    const itemSchema = origSchema?.items || {};
    return data.map((item) => stripOptionalNulls(item, itemSchema));
  }
  if (typeof data === "object") {
    const out: any = {};
    const props = origSchema?.properties || {};
    const required = origSchema?.required || [];
    for (const [k, v] of Object.entries(data)) {
      if (v === null && props[k] && !required.includes(k)) {
        continue;
      }
      out[k] = props[k] ? stripOptionalNulls(v, props[k]) : v;
    }
    return out;
  }
  return data;
}

export function openAiClient(o: {
  provider: "openai" | "gemini" | "openai_compatible";
  baseUrl: string;
  apiKey?: string;
  model: string;
  fastModel: string;
  effort: ReasoningEffort;
  temperature: number;
  fetch?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): LlmClient {
  const limiter = o.limiter ?? new Limiter(4);

  const providerLabels = {
    openai: "OpenAI",
    gemini: "Gemini",
    openai_compatible: "the OpenAI-compatible API",
  };
  const label = providerLabels[o.provider];

  /**
   * Some OpenAI-compatible servers reject `json_schema`: then ask once more in JSON mode with the
   * schema in the instructions. The retry happens outside the limiter, so it can't wait on itself.
   */
  async function callOpenAi(
    request: any,
    isObject: boolean,
  ): Promise<{ text: string; model: string; usage: any }> {
    try {
      return await attempt(request, isObject, false);
    } catch (err) {
      if (isObject && err instanceof LlmHttpError && err.status === 400) {
        return await attempt(request, isObject, true);
      }
      throw err;
    }
  }

  async function attempt(
    request: any,
    isObject: boolean,
    fallbackToObject: boolean,
  ): Promise<{ text: string; model: string; usage: any }> {
    const tier = request.tier ?? "default";
    const selectedModel = tier === "fast" ? o.fastModel || o.model : o.model;
    const reqEffort = request.effort ?? o.effort;

    const baseMaxTokens = request.maxTokens ?? 4096;
    // Gemini and OpenAI's current models think by default even without reasoning_effort,
    // and their thinking counts against the token cap: give "off" the low-effort headroom.
    let headroom = reqEffort === "off" && o.provider !== "openai_compatible" ? 8000 : 0;
    if (reqEffort === "low") headroom = 8000;
    else if (reqEffort === "medium") headroom = 16000;
    else if (reqEffort === "high") headroom = 32000;
    const max_tokens = Math.min(64000, baseMaxTokens + headroom);

    const messages = [];
    if (request.system || fallbackToObject) {
      let sys = request.system || "";
      if (fallbackToObject && isObject) {
        sys += `\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(z.toJSONSchema(request.schema))}`;
      }
      if (sys) {
        messages.push({ role: "system", content: sys });
      }
    }
    messages.push({ role: "user", content: request.prompt });

    const body: any = {
      model: selectedModel,
      messages,
    };

    if (o.provider === "openai") {
      body.max_completion_tokens = max_tokens;
    } else {
      body.max_tokens = max_tokens;
    }

    if (reqEffort !== "off") {
      body.reasoning_effort = reqEffort;
    } else if (o.provider !== "openai") {
      // OpenAI's current models reason by default and reject sampling parameters; others take it.
      body.temperature = o.temperature;
    }

    if (isObject) {
      if (fallbackToObject) {
        body.response_format = { type: "json_object" };
      } else {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "reqflow_answer",
            strict: true,
            schema: openAiStrictSchema(z.toJSONSchema(request.schema)),
          },
        };
      }
    }

    const headers: Record<string, string> = {};
    if (o.apiKey) {
      headers["Authorization"] = `Bearer ${o.apiKey}`;
    }

    let defaultTimeoutMs = 120000;
    if (reqEffort === "medium") defaultTimeoutMs = 300000;
    else if (reqEffort === "high") defaultTimeoutMs = 600000;
    const timeoutMs = o.timeoutMs ?? defaultTimeoutMs;

    let baseUrl = o.baseUrl;
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    const url = `${baseUrl}/chat/completions`;

    return limiter.run(async () => {
      const response = await postJson(url, {
        headers,
        body,
        signal: request.signal,
        fetch: o.fetch ?? fetch,
        timeoutMs,
        provider: label,
        sleep: o.sleep,
      });
      const res = response.json as any;

      const choice = res?.choices?.[0];
      if (!choice) throw new Error(`${label} returned an empty response.`);

      const msg = choice.message || {};
      if (msg.refusal) {
        throw new Error(`${label} declined to answer (refusal).`);
      }

      const finish_reason = choice.finish_reason;
      if (finish_reason === "length") {
        throw new Error(
          `${label} stopped before finishing its answer (max_tokens). Lower the effort or send fewer items per call.`,
        );
      }
      if (finish_reason === "content_filter") {
        throw new Error(`${label} declined to answer (refusal).`);
      }
      if (finish_reason !== "stop") {
        throw new Error(`${label} stopped early (${finish_reason}).`);
      }

      let textOutput = "";
      if (Array.isArray(msg.content)) {
        textOutput = msg.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("");
      } else {
        textOutput = msg.content || "";
      }

      const usage = {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };

      return {
        text: textOutput,
        model: res.model ?? selectedModel,
        usage,
      };
    }, request.signal);
  }

  return {
    async generateObject(request) {
      const result = await callOpenAi(request, true);
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new Error(`${label}'s answer is not valid JSON`);
      }
      const stripped = stripOptionalNulls(raw, z.toJSONSchema(request.schema));
      const object = request.schema.parse(stripped);
      return {
        object,
        model: result.model,
        usage: result.usage,
      };
    },
    async generateText(request) {
      const result = await callOpenAi(request, false);
      return {
        text: result.text,
        model: result.model,
        usage: result.usage,
      };
    },
  };
}
