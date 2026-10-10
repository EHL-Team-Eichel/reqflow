import {
  fixtureAuditEvents,
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import type {
  AuditEvent,
  AuditFilter,
  Requirement,
  RequirementDetail,
  RequirementFilter,
} from "@reqflow/core";
import { ReqflowError } from "./dispatch";

export function listFixtureRequirements(filter?: RequirementFilter): Requirement[] {
  let list = [...fixtureRequirements];

  if (filter?.runId) {
    list = list.filter((r) => r.runId === filter.runId);
  }
  if (filter?.status && filter.status.length > 0) {
    list = list.filter((r) => filter.status?.includes(r.status));
  }
  if (filter?.category && filter.category.length > 0) {
    list = list.filter((r) => filter.category?.includes(r.category));
  }
  if (filter?.priority && filter.priority.length > 0) {
    list = list.filter((r) => r.priority && filter.priority?.includes(r.priority));
  }
  if (filter?.evidenceLevel && filter.evidenceLevel.length > 0) {
    list = list.filter((r) => filter.evidenceLevel?.includes(r.evidenceLevel));
  }

  return list;
}

export function getFixtureRequirement(id: string): RequirementDetail {
  const req = fixtureRequirements.find((r) => r.id === id);
  if (!req) {
    throw new ReqflowError("not_found", `Requirement not found: ${id}`);
  }

  const allFindingIds = new Set([...req.findingIds, ...req.conflictingFindingIds]);
  const findings = fixtureFindings.filter((f) => allFindingIds.has(f.id));

  const sourceIds = new Set(req.sourceIds);
  const recordIds = new Set<string>();

  for (const f of findings) {
    for (const e of f.evidence) {
      sourceIds.add(e.sourceId);
      if (e.recordId) recordIds.add(e.recordId);
    }
  }

  const sources = fixtureSources.filter((s) => sourceIds.has(s.id));
  const records = fixtureRecords.filter((r) => recordIds.has(r.id));

  return {
    requirement: req,
    findings,
    sources,
    records,
    versions: [req],
  };
}

export function listFixtureAuditEvents(filter?: AuditFilter): AuditEvent[] {
  let list = [...fixtureAuditEvents];

  if (filter?.entityId) {
    list = list.filter((e) => e.entityId === filter.entityId);
  }
  if (filter?.entityType) {
    list = list.filter((e) => e.entityType === filter.entityType);
  }
  if (filter?.action) {
    list = list.filter((e) => e.action === filter.action);
  }
  if (filter?.runId) {
    list = list.filter((e) => e.runId === filter.runId);
  }
  if (filter?.actorType) {
    list = list.filter((e) => e.actor.type === filter.actorType);
  }
  if (filter?.limit && filter.limit > 0) {
    list = list.slice(0, filter.limit);
  }

  return list;
}
