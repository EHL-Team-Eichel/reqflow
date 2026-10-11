import type { ProductScope, ResearchAgentId } from "@reqflow/core";

export interface OpenCodePromptOptions {
  agentId: ResearchAgentId | string;
  scope: ProductScope;
  question?: string;
  maxResults?: number;
  outputFileName?: string;
}

const AGENT_SPECIALIZATION: Record<
  string,
  { title: string; objective: string; typicalSources: string; focusAreas: string }
> = {
  reddit: {
    title: "Reddit Automotive Discussions & Community Sentiment",
    objective:
      "Search Reddit communities (e.g. r/BMW, r/cars, r/electricvehicles, r/whatcarshouldIbuy) for real owner experiences, recurring defects, praises, and feature desires.",
    typicalSources: "Reddit posts, comments, megathreads, and AMA discussions",
    focusAreas:
      "Daily usability, real-world reliability, software bugs, build quality, steering feel, ride comfort, and dealer experience.",
  },
  youtube: {
    title: "YouTube Video Reviews & Owner Walkthroughs",
    objective:
      "Analyze automotive YouTube reviews, in-depth POV test drives, and audience comments for user sentiment and driving impressions.",
    typicalSources:
      "Car review channels (e.g. Carwow, Autogefühl, Doug DeMuro, Joe Achilles) and owner vlogs",
    focusAreas:
      "Interior ergonomics, touchscreen responsiveness, physical button removals, sound insulation, cargo space, and driving dynamics.",
  },
  instagram: {
    title: "Instagram Automotive Media & Visual Sentiment",
    objective:
      "Investigate public automotive impressions, design discussions, and enthusiast reactions on Instagram.",
    typicalSources: "Car media accounts, BMW enthusiast pages, auto show coverage",
    focusAreas:
      "Exterior aesthetics, kidney grille reactions, lighting signature, interior ambient lighting, and perceived prestige.",
  },
  tiktok: {
    title: "TikTok Automotive Trends & Short-Form Reactions",
    objective:
      "Discover viral car trends, first impressions, infotainment reactions, and younger buyer sentiment on TikTok.",
    typicalSources: "Automotive creators, tech reviewers, dealership walkarounds",
    focusAreas:
      "Digital key convenience, phone integration (CarPlay/Android Auto), ambient lighting, storage cubbies, and aesthetic appeal.",
  },
  x: {
    title: "X (Twitter) Automotive Posts & Live Commentary",
    objective:
      "Gather real-time automotive commentary, recall chatter, software update reactions, and brand perception from X.",
    typicalSources: "Journalist tweets, automotive analysts, owner posts",
    focusAreas:
      "Over-the-air update reliability, brand positioning, customer service complaints, and launch reactions.",
  },
  owner_forums: {
    title: "Dedicated BMW & Automotive Owner Forums",
    objective:
      "Examine dedicated enthusiast forum discussions (e.g. Bimmerpost, Bimmerfest, motor-talk.de, babybmw.net) for in-depth technical feedback and ownership reports.",
    typicalSources:
      "Owner forum threads, technical troubleshooting boards, DIY modification threads",
    focusAreas:
      "Known mechanical/electronic faults, suspension harshness, brake feel, seat comfort on long trips, rattles, and software glitch workarounds.",
  },
  editorial_reviews: {
    title: "Professional Editorial Automotive Reviews & Road Tests",
    objective:
      "Examine published road tests and verdicts from established automotive press (e.g. Autocar, Auto Motor und Sport, Top Gear, Car and Driver, Auto Express).",
    typicalSources:
      "Leading motoring magazines, verified comparison tests, long-term fleet reviews",
    focusAreas:
      "Chassis balance, steering precision, ride comfort over rough asphalt, cabin quietness, infotainment interface hierarchy, and comparison verdicts.",
  },
  competitor_models: {
    title: "Competitor Benchmark Analysis & Head-to-Head Comparison",
    objective:
      "Benchmark competing vehicles in the same vehicle segment (e.g. Audi A3, Mercedes-Benz A-Class, Volkswagen Golf, Tesla Model 3) against the target vehicle.",
    typicalSources:
      "Direct head-to-head comparison road tests, competitor owner feedback, spec sheets",
    focusAreas:
      "Competitor advantages in standard equipment, passenger room, trunk capacity, hybrid/EV efficiency, price-to-feature value, and premium perceived quality.",
  },
  market_studies: {
    title: "Automotive Market Studies & Buyer Demographics",
    objective:
      "Analyze automotive customer satisfaction indices (e.g. J.D. Power, NCBS), buyer demographic shifts, and premium compact segment purchasing drivers.",
    typicalSources: "Industry analyst reports, JD Power IQS/APEAL summaries, consumer surveys",
    focusAreas:
      "Purchase motivators, brand loyalty, age demographics, willingness to pay for subscription features, and powertrain adoption hurdles.",
  },
  regional_context: {
    title: "Regional Market Context, Regulation & Infrastructure",
    objective:
      "Evaluate regional driving conditions, climate demands, taxation rules, charging network density, and urban parking constraints.",
    typicalSources:
      "Regional motoring clubs (e.g. ADAC, AA), transport statistics (Eurostat), local publications",
    focusAreas:
      "Cold-weather range degradation, tight parking dimensions, emission taxes/penalties, speed limit assist compliance, and local charging standard interoperability.",
  },
  technology: {
    title: "Automotive Technology Innovations & 3-5 Year Horizon Trends",
    objective:
      "Investigate emerging automotive technologies relevant to the 3-5 year successor vehicle horizon (e.g. next-gen HUDs, steer-by-wire, silicon-carbide inverters, L2+/L3 ADAS).",
    typicalSources:
      "Tier-1 supplier announcements (Bosch, Continental, ZF), automotive engineering journals, tech conferences",
    focusAreas:
      "Augmented Reality Head-Up Displays, zonal electronic architecture, battery chemistry advancements, bidirectional charging, and predictive voice assistants.",
  },
  bmw_sales: {
    title: "BMW Delivery Figures, Take-Rates & Equipment Popularity",
    objective:
      "Analyze historical sales distributions, engine derivative popularity, take-rates of M Sport / comfort packages, and market volume trends.",
    typicalSources:
      "BMW Group quarterly investor reports, market delivery releases, KBA registration statistics",
    focusAreas:
      "Customer uptake of optional equipment, powertrain transition shares (mild-hybrid vs PHEV vs BEV), and trim level preferences.",
  },
  bmw_strategy: {
    title: "BMW Corporate Strategy & Brand Evolution",
    objective:
      "Review official BMW strategy communications (e.g. Neue Klasse design language, circular economy targets, operating system roadmaps).",
    typicalSources: "BMW Group press releases, annual reports, keynote speeches by board members",
    focusAreas:
      "Design language evolution, sustainability/recycled materials targets, operating system updates (BMW OS 9 / X), and future brand identity.",
  },
};

/**
 * Builds the comprehensive prompt provided to the OpenCode CLI.
 */
export function buildOpenCodeAgentPrompt(options: OpenCodePromptOptions): string {
  const { agentId, scope, question, maxResults = 10, outputFileName } = options;
  const fileName = outputFileName || `research_${agentId}.xlsx`;
  const spec = AGENT_SPECIALIZATION[agentId] ?? {
    title: `Automotive Research: ${agentId}`,
    objective: `Investigate primary sources and automotive feedback regarding ${agentId}.`,
    typicalSources: "Automotive websites, articles, user discussions",
    focusAreas: "Customer preferences, unmet needs, complaints, and technical benchmarks.",
  };

  const questionsSection =
    question && question.trim()
      ? `\n### Primary Research Questions & Steering:\n- ${question.trim()}\n`
      : "";

  return `You are an expert autonomous automotive research agent specialized in "${spec.title}".
Your mission is to conduct thorough, primary-source web research for BMW product managers defining the successor generation of the vehicle.

---
### Research Target & Vehicle Scope:
- **Brand**: BMW
- **Vehicle Line**: ${scope.vehicleLine} (${scope.vehicleCode})
- **Derivative (e-code)**: ${scope.derivative || "Current derivative (e.g. F70)"}
- **Target Market**: ${scope.market}
- **Planning Horizon**: ${scope.horizonYears} years ahead (successor vehicle planning)
${questionsSection}
---
### Investigation Domain & Focus:
- **Role Objective**: ${spec.objective}
- **Key Source Types**: ${spec.typicalSources}
- **Key Focus Areas**: ${spec.focusAreas}

---
### Mandatory Execution Protocol:
1. **Research Skill Check**:
   Before beginning deep research, check if the specialized research skill is installed.
   Ensure it is installed and available by running:
   \`\`\`bash
   npx skills add https://github.com/mattpocock/skills --skill research -y
   \`\`\`
   Utilize the research skill and your available tools (web search, browser/web fetching) to gather primary evidence.

2. **Evidence Integrity**:
   - Every finding must be grounded in real-world evidence, genuine customer feedback, or published automotive reports.
   - Do NOT invent quotes, URLs, or fake data.
   - Extract at least ${maxResults} distinct, high-value findings/observations.

3. **Required Output - Excel File**:
   You MUST generate a valid Microsoft Excel workbook (.xlsx) saved directly in the current working directory at:
   \`${fileName}\`

   The workbook must contain a single worksheet with a header row followed by at least ${maxResults} rows.
   The columns MUST strictly match the following standard BMW Customer Feedback headers:

   | Column Name | Description |
   | --- | --- |
   | ID | Unique record ID (e.g. OPN-${agentId.toUpperCase()}-001, OPN-${agentId.toUpperCase()}-002, ...) |
   | Source | Name of the publisher or platform (e.g. "Reddit r/BMW", "Top Gear", "Autocar", "Bimmerpost") |
   | Brand | Vehicle brand ("BMW", or competitor brand name for benchmarks) |
   | Sales Description | Specific model or trim (e.g. "BMW 120 M Sport (F70)", "Audi A3 35 TFSI") |
   | Country | Relevant market code or country (e.g. "DE", "UK", "EU", "US") |
   | Derivate (e-code) | Derivative code if applicable (e.g. "F70", "F40", "8Y") |
   | Engine Type | Powertrain type (e.g. "ICE", "Mild-Hybrid", "BEV", "PHEV") |
   | Feedback Type | Type of finding: "Complaint", "Praise", "Feature Request", "Suggestion", or "Benchmark" |
   | Customer Feedback | The verbatim feedback, excerpt, or synthesized observation detailing the customer experience |
   | Vfc level2 3 Name | Functional vehicle category in format "Level2 : Level3" (e.g. "Infotainment : Voice Control", "Driving Dynamics : Suspension & Ride Comfort", "Interior : Materials & Ergonomics", "Body & Exterior : Styling & Aerodynamics", "Comfort & Convenience : Noise Isolation", "ADAS : Highway Assist") |
   | Source URL | Direct web URL or reference link to the primary source |
   | Published At | ISO date (YYYY-MM-DD) or publication timestamp if known |

   You can write and execute a short script (e.g. Python with pandas/openpyxl, or Node.js) to generate the \`${fileName}\` file.
   Verify that \`${fileName}\` exists and is non-empty before finishing.
`;
}
