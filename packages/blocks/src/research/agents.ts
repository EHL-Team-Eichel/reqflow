import { ResearchAgentId, ResearchScope, type ResearchAgentDefinition } from "@reqflow/core";

/** Retrieval capabilities, not analytical roles. Provider approval is checked by the caller. */
export const RESEARCH_AGENTS: ResearchAgentDefinition[] = [
  {
    id: "reddit",
    label: "Reddit discussions",
    description:
      "Find original submissions, comments and their thread context through approved Reddit access.",
    providers: ["reddit"],
  },
  {
    id: "youtube",
    label: "YouTube videos and comments",
    description:
      "Find original video metadata and comments with their source context; transcripts require separate authorized access.",
    providers: ["youtube"],
  },
  {
    id: "instagram",
    label: "Instagram posts and comments",
    description:
      "Find original captions and comments through explicitly approved Instagram actors.",
    providers: ["apify"],
  },
  {
    id: "tiktok",
    label: "TikTok videos and comments",
    description:
      "Find original video descriptions and comments through explicitly approved TikTok actors.",
    providers: ["apify"],
  },
  {
    id: "x",
    label: "X posts and conversations",
    description:
      "Find original posts and conversation context within the configured X search access.",
    providers: ["x"],
  },
  {
    id: "owner_forums",
    label: "Owner forums",
    description:
      "Locate original owner discussions and replies while retaining their thread context.",
    providers: ["firecrawl"],
  },
  {
    id: "editorial_reviews",
    label: "Editorial reviews",
    description:
      "Locate original editorial road tests, review passages and published comparison tables.",
    providers: ["firecrawl"],
  },
  {
    id: "competitor_models",
    label: "Competitor models",
    description:
      "Locate original product descriptions and equipment tables for configured competing models.",
    providers: ["firecrawl"],
  },
  {
    id: "market_studies",
    label: "Market studies",
    description:
      "Locate original customer studies, market publications and accessible research passages or tables.",
    providers: ["firecrawl", "openalex"],
  },
  {
    id: "regional_context",
    label: "Regional context",
    description:
      "Locate raw regional statistics, dataset dimensions and original contextual publications.",
    providers: ["eurostat", "firecrawl"],
  },
  {
    id: "technology",
    label: "Technology publications",
    description:
      "Locate original technology publications, research passages and explicitly published forecasts.",
    providers: ["firecrawl", "openalex"],
  },
  {
    id: "bmw_sales",
    label: "BMW sales publications",
    description:
      "Locate original BMW delivery tables and sales publications, including authorized local documents.",
    providers: ["firecrawl", "local_documents"],
  },
  {
    id: "bmw_strategy",
    label: "BMW strategy publications",
    description:
      "Locate original official BMW strategy statements and authorized local document passages.",
    providers: ["firecrawl", "local_documents"],
  },
];

const topics: Record<ResearchAgentId, string> = {
  reddit: "owner experiences discussions",
  youtube: "video reviews owner experiences",
  instagram: "posts captions owner experiences",
  tiktok: "video descriptions owner experiences",
  x: "posts discussions owner experiences",
  owner_forums: "owner forum discussions vehicle experiences",
  editorial_reviews: "road tests reviews equipment usability",
  competitor_models: "comparison product descriptions equipment specifications",
  market_studies: "customer studies market research published forecasts",
  regional_context: "regional statistics transport mobility population",
  technology: "vehicle technology research publications published forecasts",
  bmw_sales:
    "deliveries sales tables official publications (site:bmwgroup.com OR site:press.bmwgroup.com)",
  bmw_strategy:
    "strategy statements official publications (site:bmwgroup.com OR site:press.bmwgroup.com)",
};

function searchText(value: string): string {
  // These are search terms, never source excerpts. Do not change collected source text here.
  return value
    .replace(/["“”`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shared deterministic anchor for the optional query planner; it makes no customer attribution. */
export function buildQueryRoot(input: ResearchScope): string {
  const scope = ResearchScope.parse(input);
  const root = searchText(
    [
      scope.brand,
      scope.model,
      scope.currentGeneration,
      scope.previousGeneration,
      scope.derivative,
      scope.propulsion,
      scope.modelYear,
      scope.markets.length ? `market context ${scope.markets.join(" ")}` : undefined,
      scope.publishedFrom ? `publication from ${scope.publishedFrom}` : undefined,
      scope.publishedTo ? `publication through ${scope.publishedTo}` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (!root || root.length > 500)
    throw new Error("Research scope identity is too long for a 500-character query.");
  return root;
}

/**
 * Build 1–3 neutral retrieval queries, without invoking an LLM or selecting a paid provider.
 * Languages, domains, URLs and dataset filters stay in scope for the source adapters to enforce.
 * Date/market terms are search context, not proof of a publication date or an author's location.
 */
export function buildQueries(agentId: ResearchAgentId, input: ResearchScope): string[] {
  const id = ResearchAgentId.parse(agentId);
  const scope = ResearchScope.parse(input);
  const root = buildQueryRoot(scope);
  const topic = searchText(
    [
      topics[id],
      id === "competitor_models"
        ? scope.competitors
            .map((car) => [car.brand, car.model, car.generation].filter(Boolean).join(" "))
            .join(" ; ")
        : undefined,
      id === "market_studies" || id === "technology"
        ? `${scope.horizonYears} year outlook`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const baseline = `${root} ${topic}`;
  if (baseline.length > 500)
    throw new Error("Research scope and expert context are too long for a 500-character query.");

  // A broad query always remains, even if the user's questions only concern complaints.
  const queries = [baseline];
  const additions = scope.keywords.length
    ? [scope.questions.join(" "), scope.keywords.join(" ")]
    : scope.questions.slice(0, 2);
  for (const addition of additions) {
    const terms = searchText(addition);
    if (!terms) continue;
    const available = 500 - baseline.length - 1;
    if (available < 1)
      throw new Error(
        "Research scope leaves no room for question or keyword search terms within 500 characters.",
      );
    const query = `${baseline} ${terms.slice(0, available).trim()}`;
    if (!queries.includes(query)) queries.push(query);
  }
  return queries;
}
