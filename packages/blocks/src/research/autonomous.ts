import { ResearchAgentId, ResearchScope, type LlmClient } from "@reqflow/core";
import { z } from "zod";
import { RESEARCH_AGENTS } from "./agents.js";

export type CompetitorModel = NonNullable<ResearchScope["competitors"]>[number];

export interface RejectionContext {
  url?: string;
  reason: string;
}

const DEFAULT_SEGMENT_COMPETITORS: Record<string, CompetitorModel[]> = {
  "1 series": [
    { brand: "Audi", model: "A3", generation: "8Y" },
    { brand: "Mercedes-Benz", model: "A-Class", generation: "W177" },
    { brand: "Volkswagen", model: "Golf", generation: "Golf 8" },
  ],
  f70: [
    { brand: "Audi", model: "A3", generation: "8Y" },
    { brand: "Mercedes-Benz", model: "A-Class", generation: "W177" },
    { brand: "Volkswagen", model: "Golf", generation: "Golf 8" },
  ],
  f40: [
    { brand: "Audi", model: "A3", generation: "8Y" },
    { brand: "Mercedes-Benz", model: "A-Class", generation: "W177" },
    { brand: "Volkswagen", model: "Golf", generation: "Golf 8" },
  ],
  "2 series": [
    { brand: "Mercedes-Benz", model: "CLA", generation: "C118" },
    { brand: "Audi", model: "A3", generation: "Sedan" },
  ],
  "3 series": [
    { brand: "Mercedes-Benz", model: "C-Class", generation: "W206" },
    { brand: "Audi", model: "A4", generation: "B9" },
    { brand: "Tesla", model: "Model 3" },
  ],
  "4 series": [
    { brand: "Audi", model: "A5", generation: "Sportback" },
    { brand: "Mercedes-Benz", model: "CLE", generation: "C236" },
  ],
  "5 series": [
    { brand: "Mercedes-Benz", model: "E-Class", generation: "W214" },
    { brand: "Audi", model: "A6", generation: "C8" },
    { brand: "Porsche", model: "Taycan" },
  ],
  g60: [
    { brand: "Mercedes-Benz", model: "E-Class", generation: "W214" },
    { brand: "Audi", model: "A6", generation: "C8" },
  ],
  "7 series": [
    { brand: "Mercedes-Benz", model: "S-Class", generation: "W223" },
    { brand: "Audi", model: "A8", generation: "D5" },
    { brand: "Porsche", model: "Panamera" },
  ],
  g70: [
    { brand: "Mercedes-Benz", model: "S-Class", generation: "W223" },
    { brand: "Audi", model: "A8", generation: "D5" },
  ],
  x1: [
    { brand: "Audi", model: "Q3", generation: "F3" },
    { brand: "Mercedes-Benz", model: "GLA", generation: "H247" },
    { brand: "Volvo", model: "XC40" },
  ],
  x3: [
    { brand: "Audi", model: "Q5", generation: "FY" },
    { brand: "Mercedes-Benz", model: "GLC", generation: "X254" },
    { brand: "Porsche", model: "Macan" },
  ],
  x5: [
    { brand: "Mercedes-Benz", model: "GLE", generation: "V167" },
    { brand: "Audi", model: "Q7", generation: "4M" },
    { brand: "Porsche", model: "Cayenne" },
  ],
};

function normalizeModelKey(value: string | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/bmw\s+/i, "");
}

function fallbackCompetitors(scope: ResearchScope): CompetitorModel[] {
  const modelKey = normalizeModelKey(scope.model);
  const derivKey = normalizeModelKey(scope.derivative);
  const genKey = normalizeModelKey(scope.currentGeneration);

  for (const key of [modelKey, derivKey, genKey]) {
    if (key && DEFAULT_SEGMENT_COMPETITORS[key]) {
      return [...DEFAULT_SEGMENT_COMPETITORS[key]!];
    }
  }

  // Fallback for compact/small premium segment
  if (modelKey.includes("1") || modelKey.includes("compact") || modelKey.includes("hatch")) {
    return [...DEFAULT_SEGMENT_COMPETITORS["1 series"]!];
  }
  // Fallback for executive segment
  if (modelKey.includes("5") || modelKey.includes("exec")) {
    return [...DEFAULT_SEGMENT_COMPETITORS["5 series"]!];
  }
  // Fallback for luxury segment
  if (modelKey.includes("7") || modelKey.includes("lux")) {
    return [...DEFAULT_SEGMENT_COMPETITORS["7 series"]!];
  }

  // Generic premium rival defaults
  return [
    { brand: "Mercedes-Benz", model: "C-Class" },
    { brand: "Audi", model: "A4" },
  ];
}

const DiscoveredCompetitorsSchema = z.object({
  competitors: z
    .array(
      z.object({
        brand: z.string().trim().min(1),
        model: z.string().trim().min(1),
        generation: z.string().trim().optional(),
      }),
    )
    .min(1)
    .max(5),
});

/**
 * Autonomously discover segment competitors if none were explicitly supplied in the scope.
 * If the user supplied competitors, they are preserved verbatim.
 */
export async function discoverCompetitors(
  scopeInput: ResearchScope,
  llm?: LlmClient,
  signal?: AbortSignal,
  reserveRequest?: () => void,
): Promise<CompetitorModel[]> {
  const scope = ResearchScope.parse(scopeInput);
  if (scope.competitors.length > 0) {
    return scope.competitors;
  }

  if (llm) {
    try {
      signal?.throwIfAborted();
      const prompt = `Target vehicle: ${scope.brand} ${scope.model} (derivative: ${scope.derivative ?? "standard"}, generation: ${scope.currentGeneration ?? "current"}).
Market context: ${scope.markets.join(", ") || "Europe / Global"}.
Time horizon: ${scope.horizonYears} years.
Identify 2 to 4 direct competitor vehicle models from rival brands in the exact same vehicle segment and market.
Return only real, commercially available competing models.`;

      const result = await llm.generateObject({
        schema: DiscoveredCompetitorsSchema,
        system:
          "You are an automotive market analyst. Return direct vehicle segment competitor models in JSON.",
        prompt,
        signal,
        tier: "default",
      });

      const parsed = DiscoveredCompetitorsSchema.safeParse(result.object);
      if (parsed.success && parsed.data.competitors.length > 0) {
        reserveRequest?.();
        return parsed.data.competitors.map((c) => ({
          brand: c.brand,
          model: c.model,
          generation: c.generation || undefined,
        }));
      }
    } catch {
      // Fall through to deterministic automotive segmentation defaults
    }
  }

  return fallbackCompetitors(scope);
}

function cleanSearchText(value: string): string {
  return value
    .replace(/[“”`]/g, '"')
    .replace(/[^\w\s\-+.:"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds targeted autonomous search queries tailored to each agent's specific role.
 * Avoids prepending the target vehicle brand/model to competitor or general technology searches.
 * Applies structured search operators ("...", OR, negative exclusions) and primary testing criteria.
 */
export function buildAutonomousQueries(
  agentIdInput: ResearchAgentId,
  scopeInput: ResearchScope,
  discoveredCompetitors?: CompetitorModel[],
): string[] {
  const agentId = ResearchAgentId.parse(agentIdInput);
  const scope = ResearchScope.parse(scopeInput);
  const competitors =
    discoveredCompetitors && discoveredCompetitors.length > 0
      ? discoveredCompetitors
      : discoverFallbackCompetitorsSync(scope);

  const vehicleAnchor = cleanSearchText(
    [scope.brand, scope.model, scope.currentGeneration, scope.derivative].filter(Boolean).join(" "),
  );

  const marketAnchor = scope.markets.length ? scope.markets.join(" ") : "";
  const queries: string[] = [];

  switch (agentId) {
    case "competitor_models": {
      for (const comp of competitors.slice(0, 3)) {
        const compName = [comp.brand, comp.model, comp.generation].filter(Boolean).join(" ");
        queries.push(
          cleanSearchText(
            `"${compName}" "road test" review usability -lease -dealer ${marketAnchor}`,
          ).slice(0, 250),
        );
        queries.push(
          cleanSearchText(
            `"${vehicleAnchor}" vs "${compName}" "comparison test" review ${marketAnchor}`,
          ).slice(0, 250),
        );
      }
      break;
    }

    case "technology": {
      const segment = getVehicleSegmentHint(scope);
      queries.push(
        cleanSearchText(
          `"${segment}" vehicle ("cockpit" OR "infotainment" OR "display") trends ${scope.horizonYears} year`,
        ).slice(0, 250),
      );
      queries.push(
        cleanSearchText(
          `"${segment}" automotive ("ADAS" OR "Level 2" OR "driver assistance") user experience ${marketAnchor}`,
        ).slice(0, 250),
      );
      queries.push(
        cleanSearchText(
          `"${vehicleAnchor}" vehicle technology ("cockpit" OR "ergonomics" OR "mild hybrid")`,
        ).slice(0, 250),
      );
      break;
    }

    case "editorial_reviews": {
      queries.push(
        cleanSearchText(
          `"${vehicleAnchor}" "road test" review equipment usability ${marketAnchor}`,
        ).slice(0, 250),
      );
      queries.push(
        cleanSearchText(`"${vehicleAnchor}" interior comfort infotainment practical test`).slice(
          0,
          250,
        ),
      );
      if (competitors[0]) {
        const compName = [competitors[0].brand, competitors[0].model].filter(Boolean).join(" ");
        queries.push(
          cleanSearchText(
            `"${vehicleAnchor}" comparison test vs "${compName}" auto motor sport carwow top gear`,
          ).slice(0, 250),
        );
      }
      break;
    }

    case "owner_forums": {
      queries.push(
        cleanSearchText(
          `${vehicleAnchor} owner forum discussions vehicle experiences complaints reliability ${marketAnchor}`,
        ).slice(0, 250),
      );
      queries.push(
        cleanSearchText(
          `${vehicleAnchor} owner forum discussions usability infotainment issues`,
        ).slice(0, 250),
      );
      break;
    }

    case "market_studies": {
      const segment = getVehicleSegmentHint(scope);
      queries.push(
        cleanSearchText(
          `${segment} customer study buying criteria automotive ${marketAnchor} ${scope.horizonYears} year`,
        ).slice(0, 250),
      );
      queries.push(
        cleanSearchText(
          `${segment} car customer satisfaction equipment preferences market study`,
        ).slice(0, 250),
      );
      break;
    }

    case "regional_context": {
      queries.push(
        cleanSearchText(
          `passenger car registrations market share ${marketAnchor} automotive statistics`,
        ).slice(0, 250),
      );
      break;
    }

    case "bmw_sales": {
      queries.push(
        cleanSearchText(
          `${scope.brand} ${scope.model} deliveries sales figures official (site:bmwgroup.com OR site:press.bmwgroup.com)`,
        ).slice(0, 250),
      );
      break;
    }

    case "bmw_strategy": {
      queries.push(
        cleanSearchText(
          `${scope.brand} strategy statement vehicle line future (site:bmwgroup.com OR site:press.bmwgroup.com)`,
        ).slice(0, 250),
      );
      break;
    }

    default: {
      queries.push(
        cleanSearchText(
          `${vehicleAnchor} ${agentId.replace(/_/g, " ")} experiences ${marketAnchor}`,
        ).slice(0, 250),
      );
      break;
    }
  }

  // Add scope-specific questions / keywords if present
  if (scope.questions.length > 0) {
    for (const q of scope.questions.slice(0, 2)) {
      const cleanQ = cleanSearchText(q);
      if (cleanQ) {
        queries.push(cleanSearchText(`${vehicleAnchor} ${cleanQ}`).slice(0, 250));
      }
    }
  }
  if (scope.keywords.length > 0) {
    const kwText = cleanSearchText(scope.keywords.join(" "));
    if (kwText) {
      queries.push(cleanSearchText(`${vehicleAnchor} ${kwText}`).slice(0, 250));
    }
  }

  // Deduplicate and cap to 3–4 queries for initial round
  return [...new Set(queries.filter((q) => q.length >= 5))].slice(0, 3);
}

function discoverFallbackCompetitorsSync(scope: ResearchScope): CompetitorModel[] {
  if (scope.competitors.length > 0) return scope.competitors;
  return fallbackCompetitors(scope);
}

function getVehicleSegmentHint(scope: ResearchScope): string {
  const modelKey = normalizeModelKey(scope.model);
  if (modelKey.includes("1") || modelKey.includes("compact") || modelKey.includes("f70")) {
    return "compact premium car";
  }
  if (modelKey.includes("3") || modelKey.includes("4")) {
    return "midsize premium sedan";
  }
  if (modelKey.includes("5") || modelKey.includes("g60")) {
    return "executive premium car";
  }
  if (modelKey.includes("7") || modelKey.includes("g70")) {
    return "luxury flagship sedan";
  }
  if (modelKey.includes("x1") || modelKey.includes("x3")) {
    return "compact premium SUV";
  }
  if (modelKey.includes("x5") || modelKey.includes("x7")) {
    return "luxury SUV";
  }
  return "passenger vehicle";
}

export interface RefinementInput {
  agentId: ResearchAgentId;
  scope: ResearchScope;
  previousQueries: string[];
  rejections: Array<{ url?: string; reason: string }>;
  acceptedCount: number;
  targetCount: number;
  discoveredCompetitors?: CompetitorModel[];
  llm?: LlmClient;
  signal?: AbortSignal;
  reserveRequest?: () => void;
}

export interface RefinementResult {
  queries: string[];
  refinementReason: string;
}

const RefinementOutputSchema = z.object({
  queries: z.array(z.string().trim().min(3).max(250)).min(1).max(3),
  refinementReason: z.string().trim().min(1).max(500),
});

/**
 * Autonomously inspects rejected sources and generates refined, improved search queries.
 */
export async function refineAgentQueries(input: RefinementInput): Promise<RefinementResult> {
  const agentDef = RESEARCH_AGENTS.find((a) => a.id === input.agentId);
  const assignment = agentDef?.description ?? input.agentId;
  const competitors =
    input.discoveredCompetitors && input.discoveredCompetitors.length > 0
      ? input.discoveredCompetitors
      : discoverFallbackCompetitorsSync(input.scope);

  const previousSet = new Set(input.previousQueries.map((q) => q.toLowerCase().trim()));

  if (input.llm && input.rejections.length > 0) {
    try {
      input.signal?.throwIfAborted();
      const prompt = `Agent assignment: ${assignment} (Agent ID: ${input.agentId}).
Target context: ${input.scope.brand} ${input.scope.model} (Market: ${input.scope.markets.join(", ") || "EU"}, Horizon: ${input.scope.horizonYears}y).
Competitor models in scope: ${competitors.map((c) => `${c.brand} ${c.model}`).join(", ") || "None specified"}.

Previous search queries used:
${input.previousQueries.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

Status: Found ${input.acceptedCount} relevant sources so far (target is ${input.targetCount}).
The previous search returned sources that were ASSESSED and REJECTED for the following reasons:
${input.rejections
  .slice(0, 6)
  .map((r, i) => `${i + 1}. ${r.url ? `[${r.url}] ` : ""}${r.reason}`)
  .join("\n")}

Task: Formulate 1 to 3 NEW, better search queries that will locate relevant, factual evidence matching the agent's assignment and avoid the specific causes of rejection above.
Rules:
- Do NOT repeat any previous queries.
- Prioritize primary, reputable automotive testing and editorial publications (road tests, comparison tests, user ergonomics, safety agencies).
- Use effective Google search operators: exact phrases ("road test", "comparison test", "in-depth review", "ergonomics", "infotainment"), negative exclusions (-lease -dealer -finance) to avoid commercial clutter.
- If rejected because results were about the target car instead of competitor models, search directly for competing models with exact quotes (e.g. "Audi A3" "road test" usability -${input.scope.brand}).
- If rejected because results were corporate reports or macroeconomic statistics, search for concrete physical vehicle tests: ("road test" OR "in-depth review") (cockpit OR space OR comfort OR boot).
- If rejected for navigation/cookie/boilerplate, specify focused evaluation terms like "verdict", "pros and cons", "interior test".
- Return JSON matching the schema.`;

      const response = await input.llm.generateObject({
        schema: RefinementOutputSchema,
        system:
          "You are an expert autonomous search query refiner for automotive product research.",
        prompt,
        signal: input.signal,
        tier: "default",
      });

      const parsed = RefinementOutputSchema.safeParse(response.object);
      if (parsed.success) {
        input.reserveRequest?.();
        const freshQueries = parsed.data.queries.filter(
          (q) => !previousSet.has(q.toLowerCase().trim()),
        );
        if (freshQueries.length > 0) {
          return {
            queries: freshQueries.slice(0, 3),
            refinementReason: parsed.data.refinementReason,
          };
        }
      }
    } catch {
      // Fall through to deterministic rule-based refinement
    }
  }

  // Deterministic rule-based query refinement when LLM is offline or query generation failed
  return fallbackRefinement(input, previousSet, competitors);
}

function fallbackRefinement(
  input: RefinementInput,
  previousSet: Set<string>,
  competitors: CompetitorModel[],
): RefinementResult {
  const vehicleAnchor = cleanSearchText(
    [input.scope.brand, input.scope.model, input.scope.currentGeneration].filter(Boolean).join(" "),
  );
  const candidates: string[] = [];

  const combinedReasons = input.rejections.map((r) => r.reason.toLowerCase()).join(" ");

  if (input.agentId === "competitor_models") {
    for (const comp of competitors) {
      const compName = [comp.brand, comp.model, comp.generation].filter(Boolean).join(" ");
      candidates.push(`"${compName}" "road test" review usability -lease`);
      candidates.push(`"${compName}" interior space boot capacity comfort test`);
      candidates.push(`"${compName}" standard equipment list options table`);
    }
  } else if (input.agentId === "technology") {
    if (combinedReasons.includes("macroeconomic") || combinedReasons.includes("corporate")) {
      candidates.push(`${vehicleAnchor} cockpit infotainment screen software review`);
      candidates.push(`${vehicleAnchor} ADAS driver assist highway lane keep test`);
      candidates.push(`compact premium car 48V mild hybrid efficiency comparison`);
    } else {
      candidates.push(`${vehicleAnchor} technical specifications innovations equipment`);
      candidates.push(`automotive display ergonomics physical buttons vs touchscreen study`);
    }
  } else if (input.agentId === "editorial_reviews") {
    candidates.push(`${vehicleAnchor} road test verdict pros cons usability`);
    candidates.push(`${vehicleAnchor} long term review fuel consumption comfort`);
    candidates.push(`${vehicleAnchor} buyer guide equipment packages recommended`);
  } else {
    candidates.push(`${vehicleAnchor} detailed customer feedback common issues`);
    candidates.push(`${vehicleAnchor} real world test experience`);
  }

  const unused = candidates
    .map(cleanSearchText)
    .filter((q) => q.length >= 5 && !previousSet.has(q.toLowerCase().trim()));

  const queries = (unused.length > 0 ? unused : candidates.slice(0, 2)).slice(0, 3);
  return {
    queries,
    refinementReason: `Refined queries to avoid rejected source topics: ${input.rejections.length} items rejected in prior round.`,
  };
}
