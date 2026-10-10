# HIL Format-Check Report

## Usage

Open a HIL review report, choose the data step to inspect, expand **Format-check PDF**,
and select the points to include. The defaults are the first three items in each dataset,
with a combined maximum of 15. Each dataset shows its first 50 candidates in source order;
this is purposeful format inspection, not representative statistical sampling.

Optional objective, owner/consulted functions, checkpoint and validation-action notes are
human-authored and report-only. **Export sample PDF** opens the native save dialog. Cancel
does not generate a file. Errors remain visible. Nothing is sent to a network service.

Saved runs use their frozen graph, scope and stored data; a source preview is explicitly
labelled as a live preview, not a saved run or review record. The PDF identifies the sampled
step separately from the HIL gate. Export never checks the review checkbox, resumes a run,
changes a requirement status or creates a reviewer signature.

## Management Improvements

The report is structured as a decision brief, not a data dump:

- A management brief exposes selected candidates, status, priority, score and evidence level.
- Review attention flags missing targets, weak/assumption-led evidence, conflicting findings,
  unselected references, missing priority rationale and recorded uncertainties.
- Human action notes encourage explicit ownership, cross-functional consultation and a next
  validation checkpoint without inventing dates or assignments.
- Full counts, selected counts and omission counts make the scope of inspection auditable.
- Upstream lineage includes nested workplace paths and routed port labels, but no block
  parameters, connection strings or runtime logs.
- Selected requirements include targets/acceptance, factor values/weights/notes, rationale,
  assumptions, uncertainties and supporting/conflicting IDs.
- Selected findings retain verbatim excerpts and source/record locators. Selected records
  retain original text and structured columns so the reviewer can check their format.
- Sources provide reliability, publisher, retrieval/publication dates and URI for traceability.
  Unselected references explicitly remain omitted instead of being expanded silently.

Absence from the PDF is not absence from the complete dataset. The sample cannot establish
decision readiness or be used as a substitute for full evidence review in ReqFlow. PDFs
can contain confidential excerpts; sharing must be limited to authorized reviewers.

## Research Basis

The three papers supplied by the user were reviewed as design input, not imported as
customer evidence or treated as an automatic prioritization policy.

### Cross-Functional Communication

Junchun Ding (2025), _Cross-Functional Team Collaboration and Project Management in the
Automotive Industry_, pp. 162-170, DOI
[10.38007/IJSSEM.2025.060218](https://doi.org/10.38007/IJSSEM.2025.060218).

Sections 2-4 emphasize information handoffs, shared goals, inter-departmental conflicts and
short feedback cycles. This motivates a common brief with lineage, specific validation
questions and named consulted functions. The paper's illustrative efficiency formulas and
examples are not used as validated BMW performance metrics.

### People, Change and Governance

Santos, Barriga, Jugend and Cauchick-Miguel (2019), _Organizational factors influencing
project success: an assessment in the automotive industry_, Production 29, e20180108, DOI
[10.1590/0103-6513.20180108](https://doi.org/10.1590/0103-6513.20180108).

The survey of 72 Brazilian automotive companies associates project success with organizational
culture, change management, top-management support, training and communication. The report
therefore foregrounds understandable rationale, explicit uncertainties and human next actions,
not just score totals. Single respondents, geographic/sample limits and model adjustment
limit generalization. These associations do not prove causation and should not become
universal scoring weights or project-success predictions.

### Concurrent Engineering and Learning

Christophe Midler and Christian Navarre (2004), _Project Management in the Automotive
Industry_, chapter 55, _The Wiley Guide to Managing Projects_, pp. 1368-1388.

Pages 1375-1377 discuss accountability and early involvement of specialist functions;
pages 1381-1382 distinguish upstream concept validation and acquired knowledge from product
launch commitments. Pages 1384-1385 highlight interfaces and negotiated compromises. This
motivates early conflict/gap visibility, a cross-functional checkpoint, and a clear distinction
between inspecting a sample, learning from evidence and approving a product requirement.
The chapter is historical; its timelines and performance benchmarks are not current BMW targets.

## Deliberate Limits and Next Steps

- Gantt, CPM and PERT require actual tasks, dependencies and duration estimates. ReqFlow does
  not have those inputs; a data lineage diagram is not a schedule or critical-path analysis.
- PDF action notes are not persisted assignments. A future review-action contract could store
  owner, due checkpoint, validation method, stakeholder response and escalation status.
- A future review record should capture reviewer identity/role, rationale, evidence version,
  change since the previous gate and closure of open questions. Existing HIL pause/resume
  events are not independent multi-reviewer signatures.
- Later exploration/commitment readiness should distinguish customer-value validation from
  feature feasibility and platform interfaces, while keeping engineering specs, regulatory
  topics and pricing/business cases outside this prototype's scope.

## Implementation and Verification

`exports.hilReport` is the typed, allowlisted IPC method. Main validates the request with
core Zod schemas: bounded metadata, unique sample IDs, nonnegative integer counts, valid
lineage references and 1-15 selected points. Samples over 2 MB are rejected explicitly,
never silently truncated. No arbitrary HTML is accepted from the renderer.

Main generates escaped HTML with no scripts or external assets and a restrictive CSP.
A hidden, sandboxed Electron window with JavaScript and Node disabled prints A4 PDF and
is destroyed on success, failure or a 15-second timeout. Native save, rendering and disk
errors propagate to the UI. No PDF library or external dependency is added.

Colocated tests cover validation, omissions, escaping, verbatim fields, reference gaps,
selection limits, cancellation, save/render/write failures, and window cleanup/security.
Desktop smoke exercises checkbox deselection, actual IPC/PDF generation and PDF signature,
and captures the expanded/saved report at desktop and minimum supported window sizes.
