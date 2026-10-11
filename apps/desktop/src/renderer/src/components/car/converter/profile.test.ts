import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildVehicleModel } from "../models/builder";
import {
  convertScene,
  mergeConvertedProfiles,
  ConversionConfigSchema,
  type ConversionConfig,
} from "./profile";

const config: ConversionConfig = {
  id: "synthetic_car",
  name: "Synthetic coupe",
  year: 2025,
  series: "Synthetic",
  chassisCode: "TEST",
  bodyType: "coupe",
  unit: "m",
  forward: "x",
  up: "y",
  powertrain: "gasoline",
};
const scenes: THREE.Object3D[] = [];
function car(wheels = true) {
  const scene = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 1.2, 1.8));
  body.name = "body";
  body.position.y = 0.9;
  scene.add(body);
  if (wheels)
    for (const x of [-1.3, 1.3])
      for (const z of [-0.75, 0.75]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, 0.2, 32).rotateX(Math.PI / 2),
        );
        wheel.name = "wheel_tire";
        wheel.position.set(x, 0.3, z);
        scene.add(wheel);
      }
  scenes.push(scene);
  return scene;
}
afterEach(() => {
  for (const scene of scenes.splice(0))
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
});

describe("local car conversion", () => {
  it("measures body, four named wheels and features, then builds selectable base-style geometry", () => {
    const scene = car();
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 1.2));
    spoiler.name = "rear_gt_wing";
    spoiler.position.set(-1.8, 1.2, 0);
    scene.add(spoiler);
    const profile = convertScene(scene, config);
    const d = profile.model.dimensions;
    expect(d.length).toBeCloseTo(4);
    expect(d.width).toBeCloseTo(1.8);
    expect(d.height).toBeCloseTo(1.5);
    expect(d.wheelbase).toBeCloseTo(2.6);
    expect(d.frontAxleX).toBeCloseTo(1.3);
    expect(d.rearAxleX).toBeCloseTo(-1.3);
    expect(d.track).toBeCloseTo(1.5);
    expect(d.tyreRadius).toBeCloseTo(0.3);
    expect(d.tyreWidth).toBeCloseTo(0.2);
    expect(profile.model.specialParts).toContain("gt_wing");
    expect(profile.report.warnings.join(" ")).not.toContain("Could not identify");
    const built = buildVehicleModel(profile.model, "gasoline");
    scenes.push(built.root);
    const ids = built.pieces.map((piece) => piece.partId);
    expect(ids).toContain("rear_spoiler");
    expect(ids).not.toContain("rear_doors");
    expect(built.anchors.has("rear_spoiler")).toBe(true);
    expect(built.root.scale.x).toBeCloseTo(4 / 4.73);
    for (const { mesh, partId } of built.pieces) {
      expect(mesh.userData.partId).toBe(partId);
      expect(Array.from(mesh.geometry.getAttribute("position").array).every(Number.isFinite)).toBe(
        true,
      );
    }
    built.sketchLines.forEach((line) => line.dispose());
  });

  it("honours nested world transforms, axis orientation and millimetre units", () => {
    const scene = car();
    // Rotate the source from x-forward/y-up into z-forward/negative-x-up.
    scene.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    scene.scale.setScalar(1000);
    scene.position.set(8500, -6400, 7200);
    const expected = convertScene(car(), config);
    const actual = convertScene(scene, { ...config, unit: "mm", forward: "z", up: "-x" });
    expect(actual.model.dimensions.length).toBeCloseTo(expected.model.dimensions.length);
    expect(actual.model.dimensions.width).toBeCloseTo(expected.model.dimensions.width);
    expect(actual.model.dimensions.height).toBeCloseTo(expected.model.dimensions.height);
    expect(actual.model.dimensions.wheelbase).toBeCloseTo(2.6);
  });

  it("calibrates arbitrary file scale from length and applies explicit metadata overrides", () => {
    const scene = car();
    scene.scale.setScalar(27);
    const result = convertScene(scene, {
      ...config,
      unit: undefined,
      dimensions: { length: 4.8, width: 2, wheelbase: 3 },
      specialParts: ["roof_rails"],
      sourceUrl: "https://sketchfab.com/3d-models/test-0123456789abcdef0123456789abcdef",
    });
    expect(result.model.dimensions.length).toBe(4.8);
    expect(result.model.dimensions.width).toBe(2);
    expect(result.model.dimensions.height).toBeCloseTo(1.8);
    expect(result.model.dimensions.wheelbase).toBe(3);
    expect(result.model.dimensions.frontAxleX).toBeCloseTo(1.5);
    expect(result.model.specialParts).toEqual(["roof_rails"]);
    expect(result.model.sketchfabUid).toBe("0123456789abcdef0123456789abcdef");
  });

  it("excludes named scene props and reports missing wheel measurements without inventing certainty", () => {
    const scene = car(false);
    const stand = new THREE.Group();
    stand.name = "Display Stand";
    stand.add(new THREE.Mesh(new THREE.BoxGeometry(100, 10, 100)));
    scene.add(stand);
    const result = convertScene(scene, { ...config, excludeMeshes: ["display stand"] });
    expect(result.report.meshCount).toBe(1);
    expect(result.model.dimensions.length).toBeCloseTo(4);
    expect(result.report.warnings.join(" ")).toContain("concept estimates");
  });

  it("rejects invalid axes, absent scale, impossible dimensions, flat and non-finite meshes", () => {
    expect(() => ConversionConfigSchema.parse({ ...config, up: "-x" })).toThrow("different axes");
    expect(() => convertScene(car(), { ...config, unit: undefined })).toThrow(
      "file scale is not guessed",
    );
    expect(() => convertScene(car(), { ...config, dimensions: { wheelbase: 8 } })).toThrow("Axles");
    expect(() => convertScene(car(), { ...config, supportedPowertrains: ["electric"] })).toThrow(
      "Default powertrain",
    );
    const scene = car();
    const position = (scene.children[0] as THREE.Mesh).geometry.getAttribute("position");
    position.setX(0, Number.NaN);
    expect(() => convertScene(scene, config)).toThrow("non-finite");
    const flat = new THREE.Group();
    flat.add(new THREE.Mesh(new THREE.PlaneGeometry(4, 2)));
    scenes.push(flat);
    expect(() => convertScene(flat, config)).toThrow("non-flat");
  });

  it("registers converted profiles, replaces catalog IDs and rejects invalid or duplicate files", () => {
    const profile = convertScene(car(), config);
    expect(mergeConvertedProfiles([], { "new.json": profile })).toEqual([profile.model]);
    const changed = { ...profile, model: { ...profile.model, name: "Replacement" } };
    expect(mergeConvertedProfiles([profile.model], { "new.json": changed })[0]?.name).toBe(
      "Replacement",
    );
    expect(() => mergeConvertedProfiles([], { "bad.json": {} })).toThrow("bad.json");
    expect(() => mergeConvertedProfiles([], { "a.json": profile, "b.json": profile })).toThrow(
      "Duplicate",
    );
  });
});
