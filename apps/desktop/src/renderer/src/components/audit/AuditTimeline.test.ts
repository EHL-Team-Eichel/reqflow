import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEvent } from "@reqflow/core";
import { fixtureAuditEvents } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { audit: { list: vi.fn() } } }));

import { AuditEventItem, AuditTimeline } from "./AuditTimeline";

const event = fixtureAuditEvents[0]!;
const renderEvent = (value: AuditEvent) =>
  renderToStaticMarkup(createElement(AuditEventItem, { event: value }));

describe("audit timeline", () => {
  it("renders labelled controls, loading feedback and the limited window warning", () => {
    const html = renderToStaticMarkup(createElement(AuditTimeline));
    expect(html).toContain("All entities");
    expect(html).toContain("Latest up to 200 events");
    expect(html).toContain("not the full history");
    expect(html).toContain("No events does not mean no changes occurred outside this window");
    expect(html).toContain("Action<select");
    expect(html).toContain("Actor type<select");
    expect(html).toContain('Search events<input type="search"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading or refreshing audit events...");
  });

  it("keys each scope independently to reset filters, errors and loaded events", () => {
    expect(AuditTimeline({}).key).toBe("global");
    expect(AuditTimeline({ requirementId: "REQ-synthetic-1" }).key).toBe(
      "requirement:REQ-synthetic-1",
    );
    expect(AuditTimeline({ requirementId: "global" }).key).not.toBe(AuditTimeline({}).key);
    const html = renderToStaticMarkup(
      createElement(AuditTimeline, { requirementId: "REQ-synthetic-1", refreshKey: 2 }),
    );
    expect(html).toContain("Requirement: REQ-synthetic-1");
  });

  it("shows action, actor identity, timestamp, entity and exact original rationale", () => {
    const synthetic: AuditEvent = {
      ...event,
      actor: { type: "ai", component: "synthetic-component", model: "synthetic-model" },
      rationale: "  First reason.\nSecond reason.  ",
    };
    const html = renderEvent(synthetic);
    expect(html).toContain(synthetic.action);
    expect(html).toContain(`dateTime="${event.at}"`);
    expect(html).toContain(event.entityId);
    expect(html).toContain(event.entityType);
    expect(html).toContain(event.id);
    expect(html).toContain("ai: synthetic-component / synthetic-model");
    expect(html).toContain("  First reason.\nSecond reason.  ");
  });

  it("renders collapsed before/after diffs with absent, null, JSON and escaped HTML", () => {
    const synthetic: AuditEvent = {
      ...event,
      rationale: '<script>alert("reason")</script>',
      changes: [
        {
          path: "description",
          before: "  original\ntext  ",
          after: '<img src=x onerror="alert(1)">',
        },
        { path: "score", before: null, after: { total: 42, notes: ["synthetic", null] } },
        { path: "optional", before: undefined, after: false },
      ],
    };
    const snapshot = structuredClone(synthetic);
    const html = renderEvent(synthetic);
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain("Field changes (3)");
    expect(html.match(/<dt[^>]*>Before<\/dt>/g)).toHaveLength(3);
    expect(html.match(/<dt[^>]*>After<\/dt>/g)).toHaveLength(3);
    expect(html).toContain("  original\ntext  ");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("null</pre>");
    expect(html).toContain("&quot;total&quot;: 42");
    expect(html).toContain("(Absent)</pre>");
    expect(html).toContain("false</pre>");
    expect(synthetic).toEqual(snapshot);
  });

  it("explicitly describes missing rationale and absent diffs without inventing them", () => {
    const html = renderEvent({ ...event, rationale: undefined, changes: [] });
    expect(html).toContain("No rationale recorded.");
    expect(html).toContain("No field diffs recorded for this event.");
    expect(html).not.toContain("<details");
    expect(renderEvent({ ...event, rationale: "", changes: [] })).not.toContain(
      "No rationale recorded.",
    );
  });
});
