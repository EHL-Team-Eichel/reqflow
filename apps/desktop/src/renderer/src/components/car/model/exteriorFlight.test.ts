import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildCar, type CarModel } from "./buildCar";
import { ExteriorFlight, VIEW_FLIGHT_MS } from "./exteriorFlight";
import { applyState, createPieceStyle, type SketchPalette } from "./sketch";

describe("ExteriorFlight", () => {
  let car: CarModel;
  let flight: ExteriorFlight;
  let homes: Map<THREE.Mesh, THREE.Vector3>;

  beforeEach(() => {
    car = buildCar();
    homes = new Map(car.pieces.map(({ mesh }) => [mesh, mesh.position.clone()]));
    flight = new ExteriorFlight(car, "exterior");
  });

  afterEach(() => {
    for (const { mesh } of car.pieces) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const geometry of car.sketchLines) geometry.dispose();
  });

  const expectAssembled = () => {
    expect(flight.progress).toBe(0);
    expect(flight.active).toBe(false);
    for (const { mesh } of car.pieces) {
      expect(mesh.position.toArray()).toEqual(homes.get(mesh)!.toArray());
      expect(mesh.visible).toBe(true);
    }
  };

  it("starts assembled and includes every exterior piece, including wheels and liners", () => {
    expectAssembled();
    expect([...flight.pieces.keys()]).toEqual(car.pieces.filter((p) => p.layer === "exterior"));
    for (const state of flight.pieces.values()) {
      expect(state.amount).toBe(0);
      expect(state.opacity).toBe(1);
      expect(state.offset.length()).toBeCloseTo(3.8);
    }
  });

  it("moves pieces outward before fading, while leaving the whole interior assembled", () => {
    flight.setView("interior", 100);
    expect(flight.update(100 + VIEW_FLIGHT_MS / 2)).toBe(true);
    expect(flight.progress).toBeCloseTo(0.5);
    expect(flight.active).toBe(true);
    for (const piece of car.pieces) {
      const distance = piece.mesh.position.distanceTo(homes.get(piece.mesh)!);
      if (piece.layer === "interior") {
        expect(distance).toBe(0);
        expect(piece.mesh.visible).toBe(true);
      } else {
        expect(distance).toBeGreaterThan(0);
        expect(distance).toBeLessThan(3.8);
        expect(flight.pieces.get(piece)!.opacity).toBe(1);
      }
    }
  });

  it("fully hides every departed exterior piece and stops requesting renders", () => {
    flight.setView("interior", 100);
    flight.update(100 + VIEW_FLIGHT_MS);
    expect(flight.progress).toBe(1);
    expect(flight.active).toBe(false);
    for (const [piece, state] of flight.pieces) {
      expect(state.amount).toBe(1);
      expect(state.opacity).toBe(0);
      expect(piece.mesh.visible).toBe(false);
    }
    expect(flight.update(10000)).toBe(false);
  });

  it("retraces the same positions and opacity when returning to Exterior", () => {
    flight.setView("interior", 0);
    flight.update(VIEW_FLIGHT_MS / 2);
    const halfway = [...flight.pieces].map(([piece, state]) => ({
      position: piece.mesh.position.toArray(),
      opacity: state.opacity,
    }));
    flight.update(VIEW_FLIGHT_MS);
    flight.setView("exterior", VIEW_FLIGHT_MS);
    flight.update(VIEW_FLIGHT_MS * 1.5);
    expect(
      [...flight.pieces].map(([piece, state]) => ({
        position: piece.mesh.position.toArray(),
        opacity: state.opacity,
      })),
    ).toEqual(halfway);
    flight.update(VIEW_FLIGHT_MS * 2);
    expectAssembled();
  });

  it("reverses mid-flight without any jump or full-duration restart", () => {
    flight.setView("interior", 0);
    flight.update(VIEW_FLIGHT_MS * 0.4);
    const before = car.pieces.map(({ mesh }) => mesh.position.toArray());
    flight.setView("exterior", VIEW_FLIGHT_MS * 0.4);
    expect(car.pieces.map(({ mesh }) => mesh.position.toArray())).toEqual(before);
    flight.update(VIEW_FLIGHT_MS * 0.6);
    expect(flight.progress).toBeCloseTo(0.2);
    flight.update(VIEW_FLIGHT_MS * 0.8 + 1);
    expectAssembled();
  });

  it("does not restart when the same view is applied again", () => {
    flight.setView("interior", 0);
    flight.setView("interior", VIEW_FLIGHT_MS / 3);
    flight.setView("interior", (VIEW_FLIGHT_MS * 2) / 3);
    flight.update(VIEW_FLIGHT_MS + 1);
    expect(flight.progress).toBe(1);
    expect(flight.active).toBe(false);
  });

  it("restores exact transforms without geometry changes after repeated round trips", () => {
    const geometry = car.pieces.map(({ mesh }) => mesh.geometry.getAttribute("position").array);
    const rotations = car.pieces.map(({ mesh }) => mesh.quaternion.toArray());
    const scales = car.pieces.map(({ mesh }) => mesh.scale.toArray());
    for (let i = 0; i < 6; i++) {
      const now = i * VIEW_FLIGHT_MS * 2;
      flight.setView("interior", now);
      flight.update(now + VIEW_FLIGHT_MS);
      flight.setView("exterior", now + VIEW_FLIGHT_MS);
      flight.update(now + VIEW_FLIGHT_MS * 2);
      expectAssembled();
    }
    for (const [index, { mesh }] of car.pieces.entries()) {
      expect(mesh.geometry.getAttribute("position").array).toBe(geometry[index]);
      expect(mesh.quaternion.toArray()).toEqual(rotations[index]);
      expect(mesh.scale.toArray()).toEqual(scales[index]);
    }
  });

  it("snaps to either endpoint for reduced motion and cancels a running flight", () => {
    flight.setView("interior", 0);
    flight.update(200);
    flight.setView("interior", 200, true);
    expect(flight.progress).toBe(1);
    expect(flight.active).toBe(false);
    flight.setView("exterior", 300, true);
    expectAssembled();
    expect(flight.update(5000)).toBe(false);
  });

  it("initializes an Interior view at its endpoint without an unwanted opening animation", () => {
    flight = new ExteriorFlight(car, "interior");
    expect(flight.progress).toBe(1);
    expect(flight.active).toBe(false);
    for (const [piece] of flight.pieces) expect(piece.mesh.visible).toBe(false);
  });

  it("binds exterior badges to moving pieces and leaves cabin badges stationary", () => {
    expect(flight.badges.has("wheels")).toBe(true);
    expect(flight.badges.has("front_doors")).toBe(true);
    expect(flight.badges.has("rear_seats")).toBe(false);
    const original = [...car.anchors].map(([id, anchor]) => [id, anchor.toArray()]);
    flight.setView("interior", 0);
    flight.update(VIEW_FLIGHT_MS);
    expect(flight.badges.get("wheels")!.opacity).toBe(0);
    expect([...car.anchors].map(([id, anchor]) => [id, anchor.toArray()])).toEqual(original);
  });

  it("updates world matrices before raycasting, not just when the renderer draws", () => {
    flight.setView("interior", 0);
    flight.update(VIEW_FLIGHT_MS / 2);
    for (const [piece] of flight.pieces) {
      const world = new THREE.Vector3().setFromMatrixPosition(piece.mesh.matrixWorld);
      expect(world.toArray()).toEqual(piece.mesh.position.toArray());
    }
  });

  it("fades selected fills and lines too, without recompiling shaders on every frame", () => {
    const piece = car.pieces.find((p) => p.layer === "exterior" && p.kind === "paint")!;
    const palette: SketchPalette = {
      background: new THREE.Color("white"),
      ink: new THREE.Color("black"),
      brand: new THREE.Color("blue"),
      selection: new THREE.Color("lightblue"),
    };
    const style = createPieceStyle(piece, palette);
    try {
      expect(applyState(piece, style, "selected", 1, palette)).toBe(true);
      expect(applyState(piece, style, "selected", 0.5, palette)).toBe(false);
      expect(style.fill.opacity).toBe(0.5);
      expect(style.lines.opacity).toBe(0.5);
      expect(style.fill.depthWrite).toBe(false);
      const version = style.fill.version;
      applyState(piece, style, "selected", 0.25, palette);
      expect(style.fill.version).toBe(version);
      piece.mesh.visible = false;
      expect(applyState(piece, style, "selected", 0, palette)).toBe(false);
      expect(style.fill.opacity).toBe(0);
      expect(style.lines.opacity).toBe(0);
    } finally {
      style.fill.dispose();
      style.lines.dispose();
    }
  });
});
