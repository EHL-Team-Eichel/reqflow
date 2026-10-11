import { z } from "zod";

export type JudgedFactor = "brand_fit" | "ease";

export interface Judgement {
  value: number;
  note: string;
  by: string;
}

export function cleanJudgementNote(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const JudgedFactorSchema = z.object({
  value: z
    .number()
    .refine(Number.isFinite, { message: "Value must be finite" })
    .transform((v) => Math.max(0, Math.min(5, v))),
  note: z
    .string()
    .min(1)
    .transform((s) => cleanJudgementNote(s)),
});

export const JudgedFactors = z.object({
  brand_fit: JudgedFactorSchema,
  ease: JudgedFactorSchema,
});

export function neutralJudgement(reason: string): Record<JudgedFactor, Judgement> {
  const note = cleanJudgementNote(`Assumption: not judged (${reason}); neutral midpoint.`);
  return {
    brand_fit: {
      value: 2.5,
      note,
      by: "deterministic",
    },
    ease: {
      value: 2.5,
      note,
      by: "deterministic",
    },
  };
}
