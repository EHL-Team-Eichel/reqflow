import { type DecisionClient, type DecisionRequest } from "@reqflow/core";
import { Limiter, postJson } from "./http";

export function jevClient(o: {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): DecisionClient {
  const limiter = o.limiter ?? new Limiter(4);
  const baseUrl = o.baseUrl || "https://api.typesafe.ai/v1";
  const model = o.model || "jev-latest";
  const timeoutMs = o.timeoutMs ?? 30000;

  return {
    async decide(request: DecisionRequest) {
      if (request.state.length > 100000) {
        throw new Error("The text is too long for Jev (max 100 000 characters)");
      }

      const url = baseUrl.endsWith("/") ? `${baseUrl}systemone` : `${baseUrl}/systemone`;

      const body = {
        state: request.state,
        model,
        questions: request.questions,
      };

      return limiter.run(async () => {
        const res = await postJson(url, {
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${o.apiKey}`,
          },
          body,
          signal: request.signal,
          fetch: o.fetch ?? fetch,
          timeoutMs,
          provider: "TypeSafe",
          sleep: o.sleep,
        });

        const data = res.json as any;
        const answers: Record<string, any> = {};

        for (const [key, q] of Object.entries(request.questions)) {
          const ans = data.answers?.[key];
          if (!ans || ans.type !== q.type) {
            throw new Error(`Jev's answer to ${key} doesn't match the question`);
          }

          if (q.type === "noul") {
            if (typeof ans.noul !== "number" || ans.noul < 0 || ans.noul > 1) {
              throw new Error(`Jev's answer to ${key} doesn't match the question`);
            }
            answers[key] = { type: "noul", value: ans.noul };
          } else if (q.type === "score") {
            if (
              typeof ans.score !== "number" ||
              ans.score < 0 ||
              ans.score > q.criteria.length - 1
            ) {
              throw new Error(`Jev's answer to ${key} doesn't match the question`);
            }
            const probs: number[] = [];
            for (let i = 0; i < q.criteria.length; i++) {
              probs.push(ans.probabilities?.[i] ?? 0);
            }
            answers[key] = {
              type: "score",
              score: ans.score,
              probabilities: probs.map((p) =>
                typeof p === "number" && Number.isFinite(p) ? p : 0,
              ),
              confidence: shapeConfidence(ans.confidence, probs),
            };
          } else if (q.type === "choice") {
            if (!q.criteria[ans.choice]) {
              throw new Error(`Jev's answer to ${key} doesn't match the question`);
            }
            const options = Object.keys(q.criteria);
            const probabilities = Object.fromEntries(
              options.map((opt) => {
                const p = ans.probabilities?.[opt];
                return [opt, typeof p === "number" && Number.isFinite(p) ? p : 0];
              }),
            );
            answers[key] = {
              type: "choice",
              choice: ans.choice,
              probabilities,
              confidence: shapeConfidence(ans.confidence, Object.values(probabilities)),
            };
          }
        }

        const usage = {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        };

        return {
          answers,
          model: data.model ?? model,
          usage,
        };
      }, request.signal);
    },
  };
}

/** Jev's own confidence when it sends one; otherwise TypeSafe's shape formula (L·max p − 1)/(L − 1). */
function shapeConfidence(given: unknown, probabilities: number[]): number {
  if (typeof given === "number" && given >= 0 && given <= 1) return given;
  const L = probabilities.length;
  if (L < 2) return 1;
  return Math.max(0, Math.min(1, (L * Math.max(...probabilities) - 1) / (L - 1)));
}
