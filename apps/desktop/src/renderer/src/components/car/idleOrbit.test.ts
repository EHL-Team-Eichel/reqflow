import { describe, expect, it } from "vitest";
import { IDLE_ORBIT_DELAY_MS, trackIdleOrbit } from "./idleOrbit";

function setup() {
  const target = new EventTarget();
  let time = 0;
  const orbit = trackIdleOrbit(target, () => time);
  return { target, orbit, advance: (ms: number) => (time += ms) };
}

describe("idle car orbit", () => {
  it("rotates immediately on opening", () => {
    expect(setup().orbit.shouldRotate()).toBe(true);
  });

  it("keeps rotating while entering, hovering over and leaving the model", () => {
    const { target, orbit, advance } = setup();
    for (const type of ["pointerenter", "pointerover", "pointermove", "pointerleave"]) {
      advance(100);
      target.dispatchEvent(new Event(type));
      expect(orbit.shouldRotate()).toBe(true);
    }
  });

  it("resumes after 30 seconds even while the pointer keeps hovering", () => {
    const { target, orbit, advance } = setup();
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("pointerup"));
    for (let i = 0; i < 30; i++) {
      expect(orbit.shouldRotate()).toBe(false);
      advance(1_000);
      target.dispatchEvent(new Event("pointermove"));
    }
    expect(orbit.shouldRotate()).toBe(true);
  });

  it.each(["pointerdown", "pointerup", "pointercancel", "wheel", "keydown", "scroll"])(
    "stops on app-wide %s and restarts after 30 seconds",
    (type) => {
      const { target, orbit, advance } = setup();
      target.dispatchEvent(new Event(type));
      expect(orbit.shouldRotate()).toBe(false);
      if (type === "pointerdown") target.dispatchEvent(new Event("pointerup"));
      advance(IDLE_ORBIT_DELAY_MS - 1);
      expect(orbit.shouldRotate()).toBe(false);
      advance(1);
      expect(orbit.shouldRotate()).toBe(true);
    },
  );

  it("restarts the full delay with each interaction", () => {
    const { target, orbit, advance } = setup();
    target.dispatchEvent(new Event("keydown"));
    advance(29_000);
    target.dispatchEvent(new Event("wheel"));
    advance(29_999);
    expect(orbit.shouldRotate()).toBe(false);
    advance(1);
    expect(orbit.shouldRotate()).toBe(true);
  });

  it("does not rotate during a held drag, even after 30 seconds", () => {
    const { target, orbit, advance } = setup();
    target.dispatchEvent(new Event("pointerdown"));
    advance(60_000);
    target.dispatchEvent(new Event("pointermove"));
    expect(orbit.shouldRotate()).toBe(false);
    target.dispatchEvent(new Event("pointerup"));
    expect(orbit.shouldRotate()).toBe(false);
    advance(30_000);
    expect(orbit.shouldRotate()).toBe(true);
  });

  it("releases a cancelled drag or one interrupted by app blur", () => {
    for (const type of ["pointercancel", "blur"]) {
      const { target, orbit, advance } = setup();
      target.dispatchEvent(new Event("pointerdown"));
      target.dispatchEvent(new Event(type));
      advance(30_000);
      expect(orbit.shouldRotate()).toBe(true);
    }
  });

  it("removes every listener on unmount", () => {
    const { target, orbit } = setup();
    orbit.dispose();
    for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "scroll"])
      target.dispatchEvent(new Event(type));
    expect(orbit.shouldRotate()).toBe(true);
  });
});
