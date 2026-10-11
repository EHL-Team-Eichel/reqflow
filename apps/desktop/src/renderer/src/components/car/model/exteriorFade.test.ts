import { describe, expect, it } from "vitest";
import { buildCar } from "./buildCar";
import { ExteriorFade, SILHOUETTE_FADE_END, VIEW_FADE_MS } from "./exteriorFade";

describe("human-selected grey-line exterior/interior fade", () => {
  it("starts at the requested endpoint without an opening animation", () => {
    for (const view of ["exterior", "interior"] as const) {
      const fade = new ExteriorFade(view);
      expect(fade.progress).toBe(view === "interior" ? 1 : 0);
      expect(fade.visibility).toBe(view === "interior" ? 0 : 1);
      expect(fade.active).toBe(false);
      expect(fade.update(10000)).toBe(false);
    }
  });

  it("smoothly fades over 850 ms instead of instantly switching", () => {
    const fade = new ExteriorFade("exterior");
    expect(VIEW_FADE_MS).toBe(850);
    fade.setView("interior", 100);
    expect(fade.update(100)).toBe(false);
    expect(fade.visibility).toBe(1);
    fade.update(100 + VIEW_FADE_MS / 4);
    expect(fade.visibility).toBeGreaterThan(0.75);
    expect(fade.visibility).toBeLessThan(1);
    fade.update(100 + VIEW_FADE_MS / 2);
    expect(fade.progress).toBe(0.5);
    expect(fade.visibility).toBeGreaterThan(0.5);
    expect(fade.visibility).toBeLessThan(0.75);
    expect(fade.active).toBe(true);
    fade.update(100 + VIEW_FADE_MS);
    expect(fade.visibility).toBe(0);
    expect(fade.active).toBe(false);
    expect(fade.update(10000)).toBe(false);
  });

  it("fades exterior silhouettes before making fills transparent, preventing solid ink blocks", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    expect(fade.silhouetteVisibility).toBe(1);
    fade.update((VIEW_FADE_MS * SILHOUETTE_FADE_END) / 2);
    expect(fade.silhouetteVisibility).toBeCloseTo(0.5);
    expect(fade.visibility).toBe(1);
    fade.update(VIEW_FADE_MS * SILHOUETTE_FADE_END);
    expect(fade.silhouetteVisibility).toBe(0);
    expect(fade.visibility).toBe(1);
    fade.update(VIEW_FADE_MS / 2);
    expect(fade.silhouetteVisibility).toBe(0);
    expect(fade.visibility).toBeLessThan(1);
    fade.update(VIEW_FADE_MS);
    fade.setView("exterior", VIEW_FADE_MS);
    fade.update(VIEW_FADE_MS * (2 - SILHOUETTE_FADE_END / 2));
    expect(fade.visibility).toBe(1);
    expect(fade.silhouetteVisibility).toBeCloseTo(0.5);
  });

  it("retraces the identical opacity curve on return", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.update(VIEW_FADE_MS / 4);
    const visibility = fade.visibility;
    fade.update(VIEW_FADE_MS);
    fade.setView("exterior", VIEW_FADE_MS);
    fade.update(VIEW_FADE_MS * 1.75);
    expect(fade.visibility).toBe(visibility);
    fade.update(VIEW_FADE_MS * 2);
    expect(fade.visibility).toBe(1);
    expect(fade.active).toBe(false);
  });

  it("reverses rapidly without jumping or restarting the full duration", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.update(VIEW_FADE_MS * 0.4);
    const visibility = fade.visibility;
    fade.setView("exterior", VIEW_FADE_MS * 0.4);
    expect(fade.visibility).toBe(visibility);
    fade.update(VIEW_FADE_MS * 0.6);
    expect(fade.progress).toBeCloseTo(0.2);
    fade.update(VIEW_FADE_MS * 0.8 + 1);
    expect(fade.visibility).toBe(1);
    expect(fade.active).toBe(false);
  });

  it("advances to the reversal time even between render frames", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.setView("exterior", VIEW_FADE_MS / 2);
    expect(fade.progress).toBe(0.5);
    expect(fade.visibility).toBeGreaterThan(0.5);
    expect(fade.visibility).toBeLessThan(0.75);
    fade.update(VIEW_FADE_MS);
    expect(fade.visibility).toBe(1);
  });

  it("does not restart on repeated requests for the same view", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.setView("interior", VIEW_FADE_MS / 3);
    fade.setView("interior", (VIEW_FADE_MS * 2) / 3);
    fade.update(VIEW_FADE_MS + 1);
    expect(fade.visibility).toBe(0);
    expect(fade.active).toBe(false);
  });

  it("snaps to either endpoint for reduced motion, including mid-transition changes", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.update(200);
    fade.setView("interior", 200, true);
    expect(fade.visibility).toBe(0);
    expect(fade.active).toBe(false);
    fade.setView("exterior", 300, true);
    expect(fade.visibility).toBe(1);
    expect(fade.active).toBe(false);
    expect(fade.update(5000)).toBe(false);
  });

  it("clamps large time steps without overshooting either endpoint", () => {
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.update(10000);
    expect(fade.progress).toBe(1);
    fade.setView("exterior", 10000);
    fade.update(20000);
    expect(fade.progress).toBe(0);
  });

  it.each(["electric", "hybrid", "h2", "gasoline"] as const)(
    "never moves, removes or explodes %s geometry or badge anchors",
    (powertrain) => {
      const car = buildCar(powertrain);
      car.root.scale.set(1.1, 0.85, 0.9);
      car.root.position.set(0, 0.2, 0);
      car.root.updateMatrixWorld(true);
      const geometry = car.pieces.map(({ mesh }) => mesh.geometry.getAttribute("position").array);
      const snapshot = () => ({
        pieces: car.pieces.map(({ mesh }) => ({
          position: mesh.position.toArray(),
          rotation: mesh.quaternion.toArray(),
          scale: mesh.scale.toArray(),
          world: mesh.matrixWorld.toArray(),
          visible: mesh.visible,
        })),
        anchors: [...car.anchors].map(([id, anchor]) => [id, anchor.toArray()]),
      });
      const original = snapshot();
      const fade = new ExteriorFade("exterior");
      try {
        for (let i = 0; i < 4; i++) {
          const now = i * VIEW_FADE_MS * 2;
          fade.setView("interior", now);
          for (const fraction of [0.25, 0.5, 0.75, 1]) {
            fade.update(now + VIEW_FADE_MS * fraction);
            expect(snapshot()).toEqual(original);
          }
          fade.setView("exterior", now + VIEW_FADE_MS);
          fade.update(now + VIEW_FADE_MS * 2);
          expect(snapshot()).toEqual(original);
        }
        for (const [index, { mesh }] of car.pieces.entries())
          expect(mesh.geometry.getAttribute("position").array).toBe(geometry[index]);
      } finally {
        for (const { mesh } of car.pieces) {
          mesh.geometry.dispose();
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            material.dispose();
        }
        for (const geometry of car.sketchLines) geometry.dispose();
      }
    },
  );
});
