import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCar, type CarModel, type CarPiece } from "../model/buildCar";
import { buildVehicleModel } from "../models/builder";
import type { PowertrainType, VehicleModel } from "../models/types";
import { buildSourceMesh } from "./buildSourceMesh";
import { buildSourceVehicle, standardInteriorPartIds } from "./buildSourceVehicle";
import type { SourceMeshProfile } from "./profile";

const powertrains: PowertrainType[] = ["electric", "hybrid", "gasoline", "h2"];

function model(overrides: Partial<VehicleModel> = {}): VehicleModel {
  return {
    id: "synthetic_sedan",
    name: "Synthetic BMW Sedan",
    sketchfabUid: "",
    year: 2025,
    series: "3 Series",
    chassisCode: "TEST",
    bodyType: "sedan",
    defaultPowertrain: "electric",
    supportedPowertrains: powertrains,
    dimensions: {
      length: 4.8,
      width: 1.9,
      height: 1.5,
      wheelbase: 2.8,
      frontAxleX: 1.4,
      rearAxleX: -1.4,
      track: 1.6,
      tyreRadius: 0.31,
      tyreWidth: 0.24,
      groundClearance: 0.2,
    },
    specialParts: [],
    description: "Synthetic fixture",
    ...overrides,
  };
}

function pack(values: number[], integer = false): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (integer) view.setUint32(index * 4, value, true);
    else view.setFloat32(index * 4, value, true);
  });
  return btoa(String.fromCharCode(...bytes));
}

function profile(vehicle = model()): SourceMeshProfile {
  const pieces: SourceMeshProfile["pieces"] = [
    {
      name: "source-body-shell",
      partId: "body",
      kind: "paint",
      layer: "exterior",
      // The unreferenced last vertex must remain in the exact exterior buffer but not move its badge.
      positions: pack([1.25, 0.2, 0.4, 1.6, 0.2, 0.4, 1.25, 0.7, 0.4, 90, 90, 90]),
      normals: pack([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: pack([0, 1, 2], true),
    },
    {
      name: "source-exhaust-tip",
      partId: "exhaust_system",
      kind: "metal",
      layer: "exterior",
      positions: pack([-2.9, 0.28, 0.75, -2.7, 0.28, 0.75, -2.9, 0.48, 0.75]),
      normals: pack([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: pack([0, 1, 2], true),
    },
    {
      name: "raw-source-dashboard",
      partId: "dashboard",
      kind: "trim",
      layer: "interior",
      positions: pack([90, 90, 90, 91, 90, 90, 90, 91, 90]),
      normals: pack([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: pack([0, 1, 2], true),
    },
    {
      name: "raw-source-body-interior",
      partId: "body",
      kind: "trim",
      layer: "interior",
      positions: pack([70, 70, 70, 71, 70, 70, 70, 71, 70]),
      normals: pack([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: pack([0, 1, 2], true),
    },
    {
      name: "raw-source-only-interior",
      partId: "h2_storage",
      kind: "trim",
      layer: "interior",
      positions: pack([80, 80, 80, 81, 80, 80, 80, 81, 80]),
      normals: pack([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: pack([0, 1, 2], true),
    },
  ];
  return {
    format: "reqflow-sketch-mesh-v1",
    model: vehicle,
    source: { url: "", author: "synthetic test", license: "CC0" },
    report: {
      meshCount: pieces.length,
      vertexCount: 16,
      detectedFeatures: [],
      warnings: [],
    },
    pieces,
  };
}

function release(car: CarModel) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const piece of car.pieces) {
    geometries.add(piece.mesh.geometry);
    for (const material of Array.isArray(piece.mesh.material)
      ? piece.mesh.material
      : [piece.mesh.material])
      materials.add(material);
  }
  for (const line of car.sketchLines) geometries.add(line);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function partsFor(car: CarModel, layer: "exterior" | "interior"): CarPiece[] {
  return car.pieces.filter((piece) => piece.layer === layer);
}

function worldPositions(piece: CarPiece): number[] {
  piece.mesh.updateWorldMatrix(true, false);
  const position = piece.mesh.geometry.getAttribute("position");
  const result: number[] = [];
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++)
    result.push(
      ...point.fromBufferAttribute(position, i).applyMatrix4(piece.mesh.matrixWorld).toArray(),
    );
  return result;
}

function anchorForPieces(pieces: CarPiece[], partId: string): THREE.Vector3 {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const { mesh } of pieces.filter((piece) => piece.partId === partId)) {
    mesh.updateWorldMatrix(true, false);
    const positions = mesh.geometry.getAttribute("position");
    const indices = mesh.geometry.index;
    if (indices) {
      for (let i = 0; i < indices.count; i++)
        box.expandByPoint(
          point.fromBufferAttribute(positions, indices.getX(i)).applyMatrix4(mesh.matrixWorld),
        );
    } else {
      for (let i = 0; i < positions.count; i++)
        box.expandByPoint(point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
    }
  }
  const anchor = box.getCenter(new THREE.Vector3());
  anchor.y = box.max.y + 0.04;
  return anchor;
}

function expectInteriorMatchesStandard(actual: CarModel, standard: CarModel) {
  standard.root.updateMatrixWorld(true);
  actual.root.updateMatrixWorld(true);
  const actualPieces = partsFor(actual, "interior");
  const standardPieces = partsFor(standard, "interior");
  expect(actualPieces).toHaveLength(standardPieces.length);
  for (let i = 0; i < standardPieces.length; i++) {
    const expected = standardPieces[i]!;
    const received = actualPieces[i]!;
    expect([received.mesh.name, received.partId, received.kind, received.layer]).toEqual([
      expected.mesh.name,
      expected.partId,
      expected.kind,
      expected.layer,
    ]);
    expect(Array.from(received.mesh.geometry.index?.array ?? [])).toEqual(
      Array.from(expected.mesh.geometry.index?.array ?? []),
    );
    const expectedPositions = worldPositions(expected);
    const receivedPositions = worldPositions(received);
    expect(receivedPositions).toHaveLength(expectedPositions.length);
    for (let vertex = 0; vertex < expectedPositions.length; vertex++)
      expect(receivedPositions[vertex]).toBeCloseTo(expectedPositions[vertex]!, 5);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("imported source vehicle composition", () => {
  it("preserves exact source exterior buffers and replaces every raw source interior piece", () => {
    const input = profile();
    const rawSource = buildSourceMesh(input);
    const expectedStandard = buildVehicleModel(input.model, "electric");
    const disposeGeometry = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");

    const composed = buildSourceVehicle(input, "electric");

    const sourceShell = rawSource.pieces.find((piece) => piece.mesh.name === "source-body-shell")!;
    const retainedShell = composed.pieces.find((piece) => piece.mesh.name === "source-body-shell")!;
    expect(retainedShell.mesh.geometry.getAttribute("position").array).toEqual(
      sourceShell.mesh.geometry.getAttribute("position").array,
    );
    expect(retainedShell.mesh.geometry.getAttribute("normal").array).toEqual(
      sourceShell.mesh.geometry.getAttribute("normal").array,
    );
    expect(retainedShell.mesh.geometry.index?.array).toEqual(
      sourceShell.mesh.geometry.index?.array,
    );
    expect(retainedShell.mesh.geometry.userData.sourceMesh).toBe(true);
    expect(retainedShell.layer).toBe("exterior");
    expect(composed.root.scale.toArray()).toEqual([1, 1, 1]);

    expect(composed.pieces.some((piece) => piece.mesh.name === "raw-source-dashboard")).toBe(false);
    expect(composed.pieces.some((piece) => piece.mesh.name === "raw-source-body-interior")).toBe(
      false,
    );
    expect(composed.pieces.some((piece) => piece.mesh.name === "raw-source-only-interior")).toBe(
      false,
    );
    expect(composed.pieces.some((piece) => piece.partId === "h2_storage")).toBe(false);
    expect(composed.anchors.has("h2_storage")).toBe(false);
    expect(
      composed.pieces
        .filter((piece) => piece.layer === "interior")
        .every((piece) => piece.mesh.geometry.userData.sourceMesh !== true),
    ).toBe(true);
    expectInteriorMatchesStandard(composed, expectedStandard);

    const disposedGeometries = new Set(disposeGeometry.mock.contexts);
    const disposedMaterials = new Set(disposeMaterial.mock.contexts);
    expect(disposedGeometries.size).toBeGreaterThan(0);
    expect(disposedMaterials.size).toBeGreaterThan(0);
    for (const piece of composed.pieces) {
      expect(disposedGeometries.has(piece.mesh.geometry)).toBe(false);
      for (const material of Array.isArray(piece.mesh.material)
        ? piece.mesh.material
        : [piece.mesh.material])
        expect(disposedMaterials.has(material)).toBe(false);
    }

    const expectedDashboardAnchor = expectedStandard.anchors.get("dashboard")!;
    expect(composed.anchors.get("dashboard")?.distanceTo(expectedDashboardAnchor)).toBeLessThan(
      0.000001,
    );
    expect(composed.anchors.get("body")?.x).toBeCloseTo(1.425, 6);
    expect(composed.anchors.get("body")?.y).toBeCloseTo(0.74, 6);
    expect(composed.anchors.get("body")?.z).toBeCloseTo(0.4, 6);

    release(rawSource);
    release(expectedStandard);
    release(composed);
  });

  it("keeps imported exterior and standard gasoline exhaust anchors separate", () => {
    const input = profile(model({ defaultPowertrain: "gasoline" }));
    const standard = buildVehicleModel(input.model, "gasoline");
    const composed = buildSourceVehicle(input, "gasoline");
    const standardInteriorAnchor = standard.anchors.get("exhaust_system")!;
    const importedExteriorAnchor = anchorForPieces(
      partsFor(composed, "exterior"),
      "exhaust_system",
    );
    const cabinAnchor = composed.anchors.get("exhaust_system")!;
    const exteriorAnchor = composed.exteriorAnchors?.get("exhaust_system")!;

    expect(cabinAnchor.distanceTo(standardInteriorAnchor)).toBeLessThan(0.000001);
    expect(exteriorAnchor.distanceTo(importedExteriorAnchor)).toBeLessThan(0.000001);
    expect(cabinAnchor.distanceTo(exteriorAnchor)).toBeGreaterThan(0.1);

    release(standard);
    release(composed);
  });

  it.each(powertrains)("matches the standard scaled cabin and chassis for %s", (powertrain) => {
    const input = profile();
    const standard = buildVehicleModel(input.model, powertrain);
    const composed = buildSourceVehicle(input, powertrain);
    expectInteriorMatchesStandard(composed, standard);
    expect(standardInteriorPartIds(input.model, powertrain)).toEqual(
      [
        ...new Set(
          partsFor(standard, "interior").flatMap((piece) => (piece.partId ? [piece.partId] : [])),
        ),
      ].sort(),
    );
    expect(
      composed.anchors.get("dashboard")?.distanceTo(standard.anchors.get("dashboard")!),
    ).toBeLessThan(0.000001);
    release(standard);
    release(composed);
  });

  it("keeps the standard model's two-seater and single-seater race exclusions and additions", () => {
    const roadster = model({
      id: "synthetic_z4_roadster",
      name: "Synthetic Z4 Roadster",
      series: "Z4",
      bodyType: "roadster",
    });
    const raceCar = model({
      id: "synthetic_gt3",
      name: "Synthetic GT3",
      series: "Motorsport",
      bodyType: "race",
      specialParts: ["roll_cage"],
    });
    const roadsterCar = buildSourceVehicle(profile(roadster), "gasoline");
    const roadsterStandard = buildVehicleModel(roadster, "gasoline");
    const raceCarModel = buildSourceVehicle(profile(raceCar), "gasoline");
    const roadsterIds = new Set(
      partsFor(roadsterCar, "interior").flatMap((piece) => (piece.partId ? [piece.partId] : [])),
    );
    const raceIds = new Set(
      partsFor(raceCarModel, "interior").flatMap((piece) => (piece.partId ? [piece.partId] : [])),
    );

    expect(roadsterIds.has("front_seats")).toBe(true);
    expect(roadsterIds.has("luggage")).toBe(true);
    expect(roadsterIds.has("rear_seats")).toBe(false);
    expect(roadsterIds.has("rear_left_seat")).toBe(false);
    expect(
      roadsterCar.anchors.get("body")?.distanceTo(roadsterStandard.anchors.get("body")!),
    ).toBeLessThan(0.000001);
    expect(roadsterCar.exteriorAnchors?.get("body")?.x).toBeCloseTo(1.425, 6);
    expect(roadsterCar.exteriorAnchors?.get("body")?.y).toBeCloseTo(0.74, 6);
    expect(roadsterCar.exteriorAnchors?.get("body")?.z).toBeCloseTo(0.4, 6);
    expect(raceIds.has("roll_cage")).toBe(true);
    expect(raceIds.has("center_console")).toBe(true);
    for (const id of [
      "rear_seats",
      "rear_left_seat",
      "passenger_seat",
      "cup_holders",
      "armrest",
      "glovebox",
      "wireless_charger",
    ])
      expect(raceIds.has(id)).toBe(false);
    expect(
      raceCarModel.pieces.some((piece) => piece.mesh.name === "raw-source-only-interior"),
    ).toBe(false);
    expect(standardInteriorPartIds(raceCar, "gasoline")).toEqual([...raceIds].sort());

    release(roadsterCar);
    release(roadsterStandard);
    release(raceCarModel);
  });

  it("returns only built interior IDs and caches IDs without retaining temporary geometry", () => {
    const sedan = model();
    const ids = standardInteriorPartIds(sedan, "electric");
    const repeated = standardInteriorPartIds(sedan, "electric");
    expect(ids).toEqual(repeated);
    expect(ids).toContain("dashboard");
    expect(ids).toContain("battery_pack");
    expect(ids).not.toContain("body");
    expect(ids).not.toContain("headlights");
    expect(ids).not.toContain("charging_port");
    expect(ids).not.toContain("rear_spoiler");
  });
});
