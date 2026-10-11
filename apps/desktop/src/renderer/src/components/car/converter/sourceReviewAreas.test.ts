import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getVehicleModelById } from "../models/registry";
import { availablePartIds, powertrainSubclasses } from "../modelSwitcher/powertrains";
import { CAR_PARTS } from "../parts";
import { visibleExteriorBadgePoint } from "../model/visibility";
import { buildSourceVehicle } from "./buildSourceVehicle";
import type { SourceMeshProfile } from "./profile";
import { sourceReviewAreaIds, sourceReviewAreaTargets } from "./sourceReviewAreas";

const m4 = getVehicleModelById("bmw_m4_competition_2025")!;
const release: (() => void)[] = [];
afterEach(() => release.splice(0).forEach((dispose) => dispose()));

function shell() {
  const { length, height, width } = m4.dimensions;
  const geometry = new THREE.BoxGeometry(length, height, width);
  geometry.translate(0, height / 2, 0);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.partId = "body";
  mesh.updateMatrixWorld(true);
  release.push(() => {
    geometry.dispose();
    material.dispose();
  });
  return mesh;
}

function cameraAt(x: number) {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  camera.position.set(x, m4.dimensions.height / 2, 0);
  camera.lookAt(0, m4.dimensions.height / 2, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function packed(values: ArrayLike<number>, integer = false) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (integer) view.setUint32(i * 4, values[i]!, true);
    else view.setFloat32(i * 4, values[i]!, true);
  }
  return btoa(String.fromCharCode(...bytes));
}

describe("M4 source exterior review areas", () => {
  it("adds ten sedan-style areas without inventing rear doors on the coupe", () => {
    const areas = sourceReviewAreaIds(m4);
    expect(areas).toHaveLength(11); // Ten added areas plus a surface anchor for the existing grille ID.
    const available = availablePartIds("electric", m4);
    for (const part of CAR_PARTS.filter((part) => part.group === "exterior")) {
      expect(available.has(part.id), part.id).toBe(part.id !== "rear_doors");
    }
    const menuIds = powertrainSubclasses("electric", m4).flatMap((group) => group.partIds);
    for (const id of areas) expect(menuIds).toContain(id);
    expect(menuIds).not.toContain("rear_doors");
    expect(new Set(menuIds).size).toBe(menuIds.length);
  });

  it("does not change review areas for the basic sedan or other imported models", () => {
    const other = { ...m4, id: "another_source_coupe" };
    expect(sourceReviewAreaIds(other)).toEqual([]);
    expect(sourceReviewAreaTargets(other, [])).toEqual(new Map());
    expect(sourceReviewAreaIds(getVehicleModelById("bmw_m5_sedan_g90_2025")!)).toEqual([]);
  });

  it("projects both-side points onto actual surfaces without changing source vertices or indices", () => {
    const mesh = shell();
    const positions = mesh.geometry.getAttribute("position").array.slice();
    const indices = mesh.geometry.index!.array.slice();
    const targets = sourceReviewAreaTargets(m4, [mesh]);
    expect([...targets.keys()]).toEqual(sourceReviewAreaIds(m4));
    for (const points of targets.values()) {
      expect(points).toHaveLength(2);
      expect(points[0]!.x).toBeCloseTo(points[1]!.x);
      expect(points[0]!.y).toBeCloseTo(points[1]!.y);
      expect(points[0]!.z).toBeCloseTo(-points[1]!.z);
    }
    expect(targets.get("headlights")![0]!.x).toBeCloseTo(m4.dimensions.length / 2);
    expect(targets.get("taillights")![0]!.x).toBeCloseTo(-m4.dimensions.length / 2);
    expect(targets.get("roof")![0]!.y).toBeCloseTo(m4.dimensions.height);
    expect(mesh.geometry.getAttribute("position").array).toEqual(positions);
    expect(mesh.geometry.index!.array).toEqual(indices);
  });

  it("keeps named points visible on broad source assemblies but hides far-side points", () => {
    const mesh = shell();
    const points = sourceReviewAreaTargets(m4, [mesh]).get("headlights")!;
    const raycaster = new THREE.Raycaster();
    expect(
      visibleExteriorBadgePoint("headlights", points, cameraAt(8), [mesh], raycaster),
    ).toBeNull();
    expect(
      visibleExteriorBadgePoint("headlights", points, cameraAt(8), [mesh], raycaster, true)?.x,
    ).toBeCloseTo(m4.dimensions.length / 2);
    expect(
      visibleExteriorBadgePoint("headlights", points, cameraAt(-8), [mesh], raycaster, true),
    ).toBeNull();
  });

  it("fails clearly rather than exposing points that have no source surface", () => {
    expect(() => sourceReviewAreaTargets(m4, [])).toThrow(
      "Could not locate M4 exterior review area",
    );
  });

  it("composes review anchors without adding exterior meshes or changing the source shape", () => {
    const mesh = shell();
    const input: SourceMeshProfile = {
      format: "reqflow-sketch-mesh-v1",
      model: m4,
      source: { url: "", author: "Synthetic fixture", license: "CC0" },
      report: { meshCount: 1, vertexCount: 24, detectedFeatures: [], warnings: [] },
      pieces: [
        {
          name: "synthetic-m4-shell",
          partId: "body",
          kind: "paint",
          layer: "exterior",
          positions: packed(mesh.geometry.getAttribute("position").array),
          normals: packed(mesh.geometry.getAttribute("normal").array),
          indices: packed(mesh.geometry.index!.array, true),
        },
      ],
    };
    const car = buildSourceVehicle(input, "electric");
    release.push(() => {
      for (const piece of car.pieces) {
        piece.mesh.geometry.dispose();
        (piece.mesh.material as THREE.Material).dispose();
      }
    });
    const exterior = car.pieces.filter((piece) => piece.layer === "exterior");
    expect(exterior).toHaveLength(1);
    expect(exterior[0]!.mesh.geometry.getAttribute("position").array).toEqual(
      mesh.geometry.getAttribute("position").array,
    );
    expect(Array.from(exterior[0]!.mesh.geometry.index!.array)).toEqual(
      Array.from(mesh.geometry.index!.array),
    );
    expect(car.exteriorReviewAreas?.size).toBe(11);
    for (const id of sourceReviewAreaIds(m4)) {
      expect(car.anchors.has(id)).toBe(true);
      expect(car.exteriorAnchors?.has(id)).toBe(true);
    }
    expect(car.anchors.has("dashboard")).toBe(true);
  });
});
