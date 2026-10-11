# Synthetic F70 Feedback Test

## Files

- `data/samples/f70-feedback-test.xlsx`: 100 invented data rows plus a header, one `Feedback_Explorer` sheet.
- `data/samples/f70-feedback-test.csv`: the same data, 101 physical lines, UTF-8 comma-separated CSV.
- `data/samples/f70-feedback-test.fixture.ts`: readable feedback and an ID/topic manifest.
- Regenerate both artifacts with `node data/samples/generate-f70-feedback-test.ts`.
- Regression tests: `npx vitest run packages/blocks/src/raw/f70-feedback-test.test.ts`.

Only sheet names, column names and row counts were inspected in the supplied workbook. No original
feedback, source values or classification values were copied. The 12 columns match that workbook:

`ID`, `Source`, `Brand`, `Sales Description`, `Country`, `Derivate (e-code)`, `Engine Type`,
`Feedback Type`, `Customer Feedback`, `Vfc level2 3 Name`, `Vfc level2 Name`, `Vfc level3 Name`.

All comments are invented English text. Every source cell says **SYNTHETIC TEST - NOT BMW DATA**;
all Vfc labels are invented, not BMW's classification taxonomy. Countries use DE/FR/IT/ES/NL codes.
The sample models a petrol F70; it contains no electric range/charging claims.

**Important:** Raw currently labels uploaded feedback provenance `bmw_internal`, publisher BMW,
high reliability. This fixture is NOT real BMW evidence, regardless of that automatic metadata or
an evidence-level badge. Keep its synthetic filename/source labels visible in demonstrations.

## Dataset Design

| Theme                         | Main rows | Intended signal                                           |
| ----------------------------- | --------: | --------------------------------------------------------- |
| Infotainment                  |        18 | Startup/reconnection failures and navigation availability |
| Physical controls             |        14 | Direct access, tactile distinctions and readable labels   |
| Rear passenger space          |        12 | Adult knee room and headroom                              |
| Front seating                 |        10 | Long-journey support and adjustability                    |
| Boot/storage                  |        10 | Pushchair/luggage loading and usable storage              |
| Climate                       |         6 | Reliable heating/cooling and stable temperature           |
| Cabin noise                   |         6 | Conversation comfort and quieter journeys                 |
| Steering                      |         6 | Consistent, predictable response                          |
| Materials/quality             |         4 | Dashboard material and finish perception                  |
| Headlights                    |         4 | Useful, even illumination on dark roads                   |
| Price/dealer/warranty/cost    |         4 | Explicit exclusions, no car requirements                  |
| Repeated classification rows  |         2 | Same ID and comment, changed Vfc labels                   |
| Independent identical wording |         2 | New IDs, retained as separate entries                     |
| Mixed infotainment opinion    |         1 | Positive and negative stance in one comment               |
| Empty comment                 |         1 | Skip with a visible explanation                           |

The ten main themes total 90 rows and each ends with one purely positive counterexample.
Duplicate classifications at worksheet rows 96/97 repeat SYN-F70-001/SYN-F70-019. Independent copies
are SYN-F70-097/SYN-F70-098; mixed opinion is SYN-F70-099; blank comment is SYN-F70-100.
IDs identify feedback entries, not verified individual customers.

## Configure The App

1. In Settings, use **1 Series / F70 / EU / five-year horizon**. Select the 1 Series visualization separately if desired; the catalog can otherwise show its M5 default without changing requirement scope.
2. For a free, reproducible run, select **Mock (offline)** and set every Add to Car agent role to **Default AI**. A role assigned its own live API setup does not become offline just because the default provider changes.
3. Start with an empty Car. Reset only if you want to remove your existing requirements; Reset is audited. Reruns can add another set, so compare counts against the pre-run state.
4. Add Raw, choose the XLSX, set dataset **Customer feedback**, sheet **Feedback_Explorer**. CSV is an alternative, not an additional source to import simultaneously.
5. Use **Raw -> AI Splitter -> three HIL blocks -> one Add to Car**. Split by **Customer priority (raw feedback)** with High/Medium/Low. Connect High to Add to Car's **1. Priority**, Medium to **2. Priority**, Low to **3. Priority** through separate HIL gates. Keep each gate at one approval.
6. Set Add to Car to three priority inputs, no context inputs, and max requirements **10**. Keep the agent configuration unchanged while comparing against the offline oracle below.
7. Start, inspect the saved splitter report, open each paused HIL report, confirm review and continue. Do not make routing corrections during the reference run; they intentionally change the expected result.

A simpler baseline is **Raw -> HIL -> Add to Car's 2. Priority** (keep three priority inputs).
It yields the same seven offline categories, all **Should have**, without a splitter.

## Expected Building-Block Results

| Block       | Expected result for this test                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw         | One source, **97 records**, **zero findings/requirements**. Merge two classification duplicates; report one skipped blank comment. Preserve both independent same-wording entries and all columns/row locators. Out-of-scope comments are still present here.                                                                                                                                                       |
| Custom      | Executes the inner workplace, not an additional AI analysis. With only Input -> Output, expect the same 97 records unchanged. With other blocks inside, expect their behavior. An unwired container is not an automatic passthrough.                                                                                                                                                                                |
| Research    | An independent source/enrichment block, not the reader for this XLSX test. Leave it out of the deterministic flow. Configured live research can add independently sourced records and provenance, changing scores/counts; there is no fixed expected number or guaranteed support for any synthetic claim. Mock AI does not make research providers offline; imports/approved providers are separate configuration. |
| AI Filter   | **Not implemented in the current registered runtime.** Expect an unsupported-block validation error for the default block. Do not expect it to remove the four exclusions. An authored inner passthrough does not implement filtering.                                                                                                                                                                              |
| AI Splitter | In recommended customer-priority mode: **High 20, Medium 65, Low 12** records, exactly one route per record, with source/evidence links retained. Analysis reports ten topic groups plus an unclassified group, support/opposition/unclear signals and explainable scores. No car requirements yet.                                                                                                                 |
| HIL         | Pauses before downstream publication. Review report shows saved evidence/lineage; continuing passes the selected branch onward unchanged in this reference run. PDF export is not approval. Continuing the flow does not set requirement status to approved. Use one reviewer; multi-reviewer enforcement is not a complete backend approval system.                                                                |
| Add to Car  | Offline context/analyst/synthesizer/architect/critic/judge pipeline publishes **seven proposed requirements** with evidence, ranking, confidence, reasoning and audit entries. Four out-of-scope findings are excluded. `maxRequirements: 10` is a ceiling, not a demand to invent ten.                                                                                                                             |

Empty splitter branches can retain source metadata, so a HIL gate may still pause even with no
records. A HIL gate does not itself semantically filter pricing comments or create requirements.

### Splitter Modes

All six modes are regression-tested to retain each of the 97 records exactly once.

| Mode                 | Interpretation / expectation                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer priority    | Recommended. Uses support frequency and expressed impact: `0.7 * frequency + 0.3 * impact`. Missing impact produces an unknown score, not zero, and uses Low. Exact offline counts: 20 / 65 / 12.                                                                      |
| Car parts            | Discovers global groups, not final Car marker assignments. Mock uses coarse keyword groups; with six outputs they cover seats/space, infotainment/controls, interior/storage, driving, range/charging, exterior. Saved branch labels do not dictate discovered groups. |
| Custom instruction   | Live models interpret the instruction; mock only handles narrow literal-label/keyword/hash rules. Example with two outputs: `Groups: Infotainment; Other`. Useful for transport tests, not proof that arbitrary instructions work.                                     |
| Priority             | Legacy six-factor score, different from customer demand. Use branch names **Must have / Should have / Could have**, not `1. Priority`. Mock gives every factor 2/5: 40/100 and **0 / 0 / 97** records at default weights/thresholds.                                   |
| Requirement category | Best for inputs with actual category fields. These Raw records have none; mock falls back to label keywords/stable IDs, so do not expect intelligent theme classification.                                                                                             |
| Sentiment            | For raw records, mock uses simple positive/negative/neutral keywords. Positive keywords win in mixed comments. This is not the customer-priority report's more explicit support/opposition/unclear analysis.                                                           |

### Offline Demand Report

Scores rounded here for readability; code uses unrounded values.

| Topic                      | Supporting entries |     Score | Topic band |
| -------------------------- | -----------------: | --------: | ---------- |
| Infotainment usability     |                 18 |     94.58 | High       |
| Passenger space            |                 12 | 66.666... | Medium     |
| Usable controls            |                 13 |     65.56 | Medium     |
| Practical storage          |                  9 |     58.33 | Medium     |
| Seating comfort            |                  9 |     50.00 | Medium     |
| Climate comfort            |                  5 |     41.94 | Medium     |
| Cabin noise                |                  5 |     38.19 | Medium     |
| Driving experience         |                  5 |     34.44 | Medium     |
| Exterior design            |                  3 |     31.67 | Low        |
| Perceived quality          |                  3 |     26.67 | Low        |
| Unclassified customer need |                  4 |   Unknown | Low        |

Passenger space is an intentional boundary check: floating-point calculation lands just below
the high-band threshold (`100 * 2 / 3`). Do not round its displayed score and then expect High.
Each main topic has one opposition entry. Infotainment additionally has one unclear mixed entry.
Praise stays in the flow, often following its topic's band; it is not silently thrown away.
Multi-topic rows use their highest-scoring topic, so a topic's Low label does not guarantee every
row mentioning it goes Low. Also, the downstream offline agents use a different category keyword
list from the splitter. Trust the saved assignment reasons over a human theme label.

## What Appears On The Car: Verified Offline Oracle

Titles use the format **[Offline] <category label>: act on customer feedback**. Exact requirement
IDs depend on prior audit history; do not expect numbering to restart after Reset.

| Requirement category | Priority in recommended flow | Finding links | Evidence badge | Current classifier placement      |
| -------------------- | ---------------------------- | ------------: | -------------- | --------------------------------- |
| Infotainment/digital | Must have                    |            20 | B              | Curved display (`curved_display`) |
| Space/practicality   | Should have                  |            23 | B              | Luggage compartment (`luggage`)   |
| Comfort              | Should have                  |            19 | B              | Dashboard (`dashboard`)           |
| Usability/controls   | Should have                  |            16 | B              | Dashboard (`dashboard`)           |
| Driving experience   | Should have                  |             6 | C              | Suspension (`suspension`)         |
| Exterior design      | Should have                  |             5 | C              | Body (`body`)                     |
| Interior quality     | Could have                   |             4 | C              | Dashboard (`dashboard`)           |

**All seven remain proposed.** There should be no pricing/dealer/warranty requirement, no invented
competitor/web evidence, and no electric charging requirement. A human must approve/reject/defer.
The simple baseline changes all seven priorities to Should have, not the category counts.

These are actual offline outputs, not the desired product-quality result. Offline agents collapse
rear space and boot storage into one category, and seating/climate/noise into another. Keywords can
also put some comments in unexpected categories, including an exterior requirement promoted by a
multi-topic row. Broad titles dominate the renderer's part classifier, explaining why Comfort lands
on Dashboard and lighting on Body. Part confidence is not AI confidence. Off-model parts can remain
in the requirement list even when the selected schematic does not show their marker.

Offline targets are generic: **Better than the current model**, tested in a customer clinic.
Its synthesizer treats praise as support and does **not** report real conflicting-evidence groups.
The B badges come from ten or more mentions, not independent real sources or validated research.
Mock mode is a plumbing/regression test, not validation of AI quality or customer representativeness.

## Desired Live-AI Results

With properly configured live agents, look for approximately these ten distinct needs. Wording,
count, scores, priorities and marker placement are model-dependent; this is an acceptance checklist,
not a promised exact output. Their measurements below are **proposed PM test criteria**, not claims
established by these invented comments. The model must label numeric thresholds as assumptions or
proposed targets and justify any merges or held-back themes.

| Desired requirement                                                   | Likely part                   | Proposed acceptance check                                                                                                   |
| --------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Reliable navigation/phone integration, including restart/reconnection | Curved display / infotainment | Complete 100 start/stop/reconnect cycles with no unrecoverable session; measure startup and recovery time.                  |
| Direct, distinguishable physical controls for frequent tasks          | Controls / dashboard          | At least 90% of clinic participants find demisting and frequent controls on the first attempt, including a gloves scenario. |
| Usable rear knee room and headroom for adults                         | Rear seats / cabin            | In an agreed driver/passenger size envelope, at least 80% rate knee room/headroom acceptable for a one-hour journey.        |
| Supportive, adjustable front seats on long trips                      | Front seats                   | At least 80% rate support acceptable after a two-hour representative journey.                                               |
| Boot that accommodates family loading tasks                           | Boot/luggage compartment      | Load the PM-defined folded pushchair plus two weekend bags without removing the parcel shelf or folding the rear bench.     |
| Dependable heating/cooling and stable cabin temperature               | Climate / vents               | Complete agreed cold/hot-weather use cases without restart; passengers rate temperature stability acceptable.               |
| Reduced cabin noise that permits conversation                         | Acoustic glazing / cabin      | Measure conversation intelligibility and perceived noise on a defined motorway route against the current baseline.          |
| Predictable steering while preserving praised handling                | Steering / suspension         | At least 80% rate steering predictability acceptable on an agreed route; no regression in the positive handling clinic.     |
| Better perceived dashboard material/finish quality                    | Dashboard / interior trim     | Blind comparison against the current baseline; at least 80% rate the successor equal or better.                             |
| Even, useful headlight illumination on dark roads                     | Headlights                    | Drivers detect agreed road features/bends on a controlled night route and report no unacceptable dark patches.              |

For each live requirement, inspect verbatim excerpts and row locators, scope F70/EU, rationale,
targets, assumptions, uncertainty, positive counter-evidence, confidence and the recorded agent
trace. Prioritize navigation most strongly; rear space and controls should be prominent. Do not
assert precise live priority bands before inspecting that run's demand report.

Evidence is one synthetic feedback workbook. It cannot establish competitor superiority, market
growth, engineering feasibility, actual sales impact or statistical representativeness. A convincing
requirement should acknowledge the positive counterexample for its theme instead of claiming all
customers agree. If the live result still loses all conflicting evidence or produces only generic
targets, treat that as an AI-quality failure to investigate, not a successful semantic test.
