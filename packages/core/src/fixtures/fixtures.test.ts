// SYNTHETIC demo data for development and tests — NOT BMW data, NOT real customer quotes.
import { describe, it, expect } from "vitest";
import {
  fixtureScope,
  fixtureSources,
  fixtureRecords,
  fixtureFindings,
  fixtureThemes,
  fixtureRequirements,
  fixtureWorkflow,
  fixtureRun,
  fixtureAuditEvents,
  fixturePipelineData,
} from "./index";
import {
  ProductScope,
  Source,
  SourceRecord,
  Finding,
  Theme,
  Requirement,
  WorkflowRun,
  Workflow,
  PipelineData,
  AuditEvent,
  DEFAULT_SETTINGS,
  weightedTotal,
  priorityForScore,
  ScoreFactor,
  FindingKind,
  validateGraph,
} from "../index";

describe("synthetic fixture data", () => {
  it("parses against domain schemas without error", () => {
    expect(() => ProductScope.parse(fixtureScope)).not.toThrow();
    fixtureSources.forEach((s) => expect(() => Source.parse(s)).not.toThrow());
    fixtureRecords.forEach((r) => expect(() => SourceRecord.parse(r)).not.toThrow());
    fixtureFindings.forEach((f) => expect(() => Finding.parse(f)).not.toThrow());
    fixtureThemes.forEach((t) => expect(() => Theme.parse(t)).not.toThrow());
    fixtureRequirements.forEach((req) => expect(() => Requirement.parse(req)).not.toThrow());
    expect(() => Workflow.parse(fixtureWorkflow)).not.toThrow();
    expect(() => WorkflowRun.parse(fixtureRun)).not.toThrow();
    fixtureAuditEvents.forEach((e) => expect(() => AuditEvent.parse(e)).not.toThrow());
    expect(() => PipelineData.parse(fixturePipelineData)).not.toThrow();
  });

  it("has a valid workflow whose run covers every top-level block", () => {
    expect(validateGraph(fixtureWorkflow)).toEqual([]);
    expect(fixtureRun.blockRuns.map((r) => r.blockId).sort()).toEqual(
      fixtureWorkflow.blocks.map((b) => b.id).sort(),
    );
  });

  it("maintains referential integrity", () => {
    const sourceIds = new Set(fixtureSources.map((s) => s.id));
    const recordIds = new Set(fixtureRecords.map((r) => r.id));
    const findingIds = new Set(fixtureFindings.map((f) => f.id));
    const themeIds = new Set(fixtureThemes.map((t) => t.id));

    // record.sourceId ∈ sources
    fixtureRecords.forEach((r) => {
      expect(sourceIds.has(r.sourceId)).toBe(true);
    });

    // finding evidence sourceId ∈ sources and recordId ∈ records
    // excerpt is a substring of that record's text
    // theme.findingIds ∈ findings and finding.themeId ∈ themes
    fixtureFindings.forEach((f) => {
      f.evidence.forEach((e) => {
        expect(sourceIds.has(e.sourceId)).toBe(true);
        if (e.recordId) {
          expect(recordIds.has(e.recordId)).toBe(true);
          const rec = fixtureRecords.find((r) => r.id === e.recordId)!;
          expect(rec.text).toContain(e.excerpt);
        }
      });
      if (f.themeId) {
        expect(themeIds.has(f.themeId)).toBe(true);
        expect(fixtureThemes.find((t) => t.id === f.themeId)!.findingIds).toContain(f.id);
      }
      expect(f.inScope || Boolean(f.outOfScopeReason), `${f.id} needs an outOfScopeReason`).toBe(
        true,
      );
    });

    fixtureThemes.forEach((t) => {
      t.findingIds.forEach((fid) => {
        expect(findingIds.has(fid)).toBe(true);
      });
    });

    // requirement findingIds & conflictingFindingIds ∈ findings
    // requirement.sourceIds equals the set of evidence sourceIds of its findings
    fixtureRequirements.forEach((r) => {
      const evidenceSourceIds = new Set<string>();

      r.findingIds.forEach((fid) => {
        expect(findingIds.has(fid)).toBe(true);
        const finding = fixtureFindings.find((f) => f.id === fid)!;
        finding.evidence.forEach((e) => evidenceSourceIds.add(e.sourceId));
      });
      r.conflictingFindingIds.forEach((fid) => {
        expect(findingIds.has(fid)).toBe(true);
        const finding = fixtureFindings.find((f) => f.id === fid)!;
        finding.evidence.forEach((e) => evidenceSourceIds.add(e.sourceId));
      });

      const reqSourceIds = new Set(r.sourceIds);
      expect(reqSourceIds).toEqual(evidenceSourceIds);
    });
  });

  it("verifies scores logic", () => {
    fixtureRequirements.forEach((req) => {
      const score = req.score;
      expect(score, `${req.id} must be scored`).toBeDefined();
      if (!score) return;

      const values: Record<ScoreFactor, number> = {
        customer_impact: score.factors.customer_impact.value,
        evidence_strength: score.factors.evidence_strength.value,
        competitive_gap: score.factors.competitive_gap.value,
        trend_momentum: score.factors.trend_momentum.value,
        brand_fit: score.factors.brand_fit.value,
        ease: score.factors.ease.value,
      };

      for (const f of ScoreFactor.options) {
        expect(score.factors[f].weight).toBe(DEFAULT_SETTINGS.scoring.weights[f]);
      }

      const total = weightedTotal(values, DEFAULT_SETTINGS.scoring.weights);
      expect(score.total).toBe(total);

      const suggestedPriority = priorityForScore(total, DEFAULT_SETTINGS.scoring.thresholds);
      expect(score.suggestedPriority).toBe(suggestedPriority);
    });
  });

  it("covers required values and maintains uniqueness", () => {
    // coverage
    const findingKinds = new Set(fixtureFindings.map((f) => f.kind));
    for (const kind of FindingKind.options) {
      expect(findingKinds.has(kind)).toBe(true);
    }

    const statuses = new Set(fixtureRequirements.map((r) => r.status));
    expect(statuses).toContain("proposed");
    expect(statuses).toContain("in_review");
    expect(statuses).toContain("challenged");
    expect(statuses).toContain("approved");
    expect(statuses).toContain("rejected");

    const levels = new Set(fixtureRequirements.map((r) => r.evidenceLevel));
    expect(levels).toContain("A");
    expect(levels).toContain("B");
    expect(levels).toContain("C");
    expect(levels).toContain("D");

    // IDs uniqueness
    const checkUnique = (items: { id: string }[], name: string) => {
      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    };
    checkUnique(fixtureSources, "sources");
    checkUnique(fixtureRecords, "records");
    checkUnique(fixtureFindings, "findings");
    checkUnique(fixtureThemes, "themes");
    checkUnique(fixtureRequirements, "requirements");
  });

  it("checks audit constraints", () => {
    let lastTime = 0;
    const reqIds = new Set(fixtureRequirements.map((r) => r.id));

    fixtureAuditEvents.forEach((evt) => {
      const current = new Date(evt.at).getTime();
      expect(current).toBeGreaterThan(lastTime);
      lastTime = current;

      if (evt.actor.type === "human" && evt.action !== "requirement.viewed") {
        expect(evt.rationale).toBeTruthy();
        expect(evt.rationale?.length).toBeGreaterThan(0);
      }

      if (evt.entityType === "requirement" && evt.action.startsWith("requirement.")) {
        expect(reqIds.has(evt.entityId)).toBe(true);
      }
    });
  });

  it("models the PM-only rules: one scope exclusion, audited priority override", () => {
    expect(fixtureFindings.filter((f) => !f.inScope)).toHaveLength(1);

    for (const req of fixtureRequirements) {
      if (req.priority === req.score?.suggestedPriority) continue;
      const override = fixtureAuditEvents.find(
        (e) =>
          e.entityId === req.id &&
          e.actor.type === "human" &&
          e.changes.some((c) => c.path === "priority" && c.after === req.priority),
      );
      expect(override, `${req.id} priority override must be audited`).toBeDefined();
    }

    // Only humans move a requirement to a decided state.
    for (const e of fixtureAuditEvents) {
      const decided = e.changes.some(
        (c) =>
          c.path === "status" && ["approved", "rejected", "deferred"].includes(c.after as string),
      );
      if (decided) expect(e.actor.type).toBe("human");
    }
  });
});
