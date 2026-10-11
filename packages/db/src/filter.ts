import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  Actor,
  FilterOverride,
  FilterReport,
  FilterReview,
  FilterReviewState,
  type AuditEventInput,
  walkBlocks,
  BlockRun,
  BlockId,
  WorkflowGraph,
} from "@reqflow/core";
import { SqliteAuditLogger } from "./audit";

export class FilterOverrideConflictError extends Error {
  constructor(message = "Filter review version changed; reload before restoring items.") {
    super(message);
    this.name = "FilterOverrideConflictError";
  }
}

export class FilterOverrideValidationError extends Error {}
export class FilterOverrideStateError extends Error {}
const WorkflowId = z.string().regex(/^wf_[A-Za-z0-9_-]{1,100}$/);

/**
 * FilterOverrideRepository manages persistent AI Filter item restoration overrides.
 * Overrides persist in SQLite independently from historical runs and are append-only.
 */
export class FilterOverrideRepository {
  constructor(private readonly db: DatabaseSync) {}

  async get(workflowId: string, blockId: string): Promise<FilterReviewState> {
    WorkflowId.parse(workflowId);
    BlockId.parse(blockId);

    const stmt = this.db.prepare(`
      SELECT item_id, item_hash, configuration_hash, version, actor, at, rationale
      FROM filter_overrides
      WHERE workflow_id = ? AND block_id = ?
      ORDER BY id ASC
    `);

    const rows = stmt.all(workflowId, blockId) as Array<{
      item_id: string;
      item_hash: string;
      configuration_hash: string;
      version: number;
      actor: string;
      at: string;
      rationale: string;
    }>;

    const totalCount = rows.length;
    const latestMap = new Map<string, FilterOverride>();

    for (const row of rows) {
      const override: FilterOverride = {
        itemId: row.item_id,
        itemHash: row.item_hash,
        configurationHash: row.configuration_hash,
        actor: JSON.parse(row.actor),
        at: row.at,
        rationale: row.rationale,
        version: row.version,
      };
      FilterOverride.parse(override);
      const fingerprint = `${row.item_id}:${row.item_hash}:${row.configuration_hash}`;
      latestMap.set(fingerprint, override);
    }

    const state: FilterReviewState = {
      version: totalCount,
      overrides: Array.from(latestMap.values()),
    };
    return FilterReviewState.parse(state);
  }

  async restore(
    workflowId: string,
    blockId: string,
    report: FilterReport,
    review: FilterReview,
    actor: Actor,
  ): Promise<FilterReviewState> {
    WorkflowId.parse(workflowId);
    BlockId.parse(blockId);

    const validatedReport = FilterReport.parse(report);
    const validatedReview = FilterReview.parse(review);
    const validatedActor = Actor.parse(actor);

    if (validatedActor.type !== "human") {
      throw new FilterOverrideValidationError("A human must restore an item");
    }

    if (validatedReport.blockId !== blockId) {
      throw new FilterOverrideValidationError(
        `Report blockId "${validatedReport.blockId}" does not match requested blockId "${blockId}"`,
      );
    }

    // Lock before checking the source run as well as the override version.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = this.db
        .prepare("SELECT id, workflow_id, status, graph, block_runs FROM runs WHERE id = ?")
        .get(validatedReport.runId) as
        | {
            id: string;
            workflow_id: string;
            status: string;
            graph: string;
            block_runs: string;
          }
        | undefined;

      if (!runRow) {
        throw new FilterOverrideValidationError(`Run not found: ${validatedReport.runId}`);
      }

      if (runRow.workflow_id !== workflowId) {
        throw new FilterOverrideValidationError(
          `Run workflowId "${runRow.workflow_id}" does not match requested workflowId "${workflowId}"`,
        );
      }

      // Source run must be completed or waiting_for_review (reject failed/cancelled/queued/running to avoid races)
      if (runRow.status !== "completed" && runRow.status !== "waiting_for_review") {
        throw new FilterOverrideStateError(
          `Cannot restore filter items on run ${validatedReport.runId} with status "${runRow.status}". Source run must be completed or waiting_for_review.`,
        );
      }

      const graph = WorkflowGraph.parse(JSON.parse(runRow.graph));
      const allBlocks = [...walkBlocks(graph)].map(({ block }) => block);
      const targetBlock = allBlocks.find((b) => b.id === blockId);
      if (!targetBlock) {
        throw new FilterOverrideValidationError(
          `Block "${blockId}" not found in workflow run graph`,
        );
      }
      if (targetBlock.kind !== "ai_filter") {
        throw new FilterOverrideValidationError(
          `Block "${blockId}" is kind "${targetBlock.kind}", expected "ai_filter"`,
        );
      }

      const blockRuns = z.array(BlockRun).parse(JSON.parse(runRow.block_runs));
      const targetBlockRun = blockRuns.find((b) => b.blockId === blockId);
      if (!targetBlockRun) {
        throw new FilterOverrideValidationError(
          `Block run state not found for block "${blockId}" in run "${validatedReport.runId}"`,
        );
      }
      if (targetBlockRun.status !== "succeeded") {
        throw new FilterOverrideStateError(
          `Block run for "${blockId}" has status "${targetBlockRun.status}", expected "succeeded"`,
        );
      }
      if (!targetBlockRun.filterReport) {
        throw new FilterOverrideStateError(
          `Authoritative filter report is missing from block "${blockId}"`,
        );
      }

      const authoritativeReport = FilterReport.parse(targetBlockRun.filterReport);
      if (
        authoritativeReport.runId !== validatedReport.runId ||
        authoritativeReport.blockId !== validatedReport.blockId ||
        authoritativeReport.configurationHash !== validatedReport.configurationHash ||
        authoritativeReport.schemaVersion !== validatedReport.schemaVersion ||
        !isDeepStrictEqual(authoritativeReport, JSON.parse(JSON.stringify(validatedReport)))
      ) {
        throw new FilterOverrideValidationError(
          "Supplied report does not match authoritative persisted report",
        );
      }

      const decisionMap = new Map(validatedReport.decisions.map((d) => [d.itemId, d]));
      const inputIds = new Set(
        validatedReport.originalInput[validatedReport.primaryLayer].map((item) => item.id),
      );
      if (
        decisionMap.size !== validatedReport.decisions.length ||
        decisionMap.size !== inputIds.size ||
        [...decisionMap.keys()].some((id) => !inputIds.has(id))
      ) {
        throw new FilterOverrideValidationError(
          "Filter report requires complete unique input ID coverage",
        );
      }
      for (const itemId of validatedReview.itemIds) {
        const decision = decisionMap.get(itemId);
        if (!decision) {
          throw new FilterOverrideValidationError(
            `Item "${itemId}" not found in filter report decisions`,
          );
        }
        if (decision.outcome === "keep") {
          throw new FilterOverrideValidationError(
            `Item "${itemId}" was kept and cannot be restored`,
          );
        }
        if (decision.outcome === "review" && decision.forwarded && !decision.retainedAsContext) {
          throw new FilterOverrideValidationError(
            `Item "${itemId}" is already forwarded, not held for review`,
          );
        }
      }

      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM filter_overrides WHERE workflow_id = ? AND block_id = ?",
        )
        .get(workflowId, blockId) as { count: number };
      const currentVersion = Number(countRow.count);

      if (currentVersion !== validatedReview.expectedVersion) {
        throw new FilterOverrideConflictError(
          `Filter review version changed (current: ${currentVersion}, expected: ${validatedReview.expectedVersion}); reload before restoring items.`,
        );
      }

      const nowIso = new Date().toISOString();
      const insertStmt = this.db.prepare(`
        INSERT INTO filter_overrides (
          workflow_id, block_id, item_id, item_hash, configuration_hash,
          version, actor, at, rationale, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [index, itemId] of validatedReview.itemIds.entries()) {
        const decision = decisionMap.get(itemId)!;

        const override: FilterOverride = {
          itemId,
          itemHash: decision.itemHash,
          configurationHash: validatedReport.configurationHash,
          actor: validatedActor,
          at: nowIso,
          rationale: validatedReview.rationale,
          version: currentVersion + index + 1,
        };
        FilterOverride.parse(override);

        insertStmt.run(
          workflowId,
          blockId,
          override.itemId,
          override.itemHash,
          override.configurationHash,
          override.version,
          JSON.stringify(override.actor),
          override.at,
          override.rationale,
          nowIso,
        );
      }

      const auditEvent: AuditEventInput = {
        actor: validatedActor,
        action: "filter.restored",
        entityType: "filter",
        entityId: blockId,
        runId: validatedReport.runId,
        blockId,
        rationale: validatedReview.rationale,
        changes: validatedReview.itemIds.map((itemId) => {
          const decision = decisionMap.get(itemId)!;
          return {
            path: `filter.${blockId}.items.${itemId}`,
            before: decision.outcome,
            after: "keep",
          };
        }),
      };
      new SqliteAuditLogger(this.db).recordSync(auditEvent);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return await this.get(workflowId, blockId);
  }
}
