import { describe, expect, it } from "vitest";
import { startControl } from "./start-control";

describe("full-workflow Start button", () => {
  it("offers Start for a nonempty flow and explains the full-workflow scope", () => {
    expect(startControl(null, false, 2)).toMatchObject({ label: "Start", disabled: false });
    expect(startControl(null, false, 2).title).toMatch(/entire workflow.*inner workplaces/);
    expect(startControl(null, false, 2).title).toMatch(/HIL.*human review/);
  });

  it("disables an empty flow and explains how to enable it", () => {
    expect(startControl(null, false, 0)).toEqual({
      label: "Start",
      disabled: true,
      title: "Add building blocks before starting the flow.",
    });
  });

  it("prevents duplicate starts while the flow is being saved", () => {
    expect(startControl(null, true, 2)).toMatchObject({ label: "Starting…", disabled: true });
  });

  it.each([
    ["queued", "Queued…"],
    ["running", "Running…"],
    ["waiting_for_review", "Review required"],
  ] as const)("disables Start while %s instead of launching a second run", (status, label) => {
    expect(startControl(status, false, 2)).toMatchObject({ label, disabled: true });
    expect(startControl(status, true, 2)).toMatchObject({ label, disabled: true });
  });

  it("never suggests that a HIL pause will resume automatically", () => {
    expect(startControl("waiting_for_review", false, 2).title).toMatch(/paused for human review/);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "allows starting the current flow again after %s",
    (status) => {
      expect(startControl(status, false, 2)).toMatchObject({ label: "Start", disabled: false });
    },
  );
});
