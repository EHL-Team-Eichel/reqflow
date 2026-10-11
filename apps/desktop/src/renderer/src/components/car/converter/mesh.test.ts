import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ALL_CAR_PARTS, WHOLE_CAR } from "../parts";
import partIds from "./partIds.json";
import { buildSourceMesh } from "./buildSourceMesh";
import {
  convertSketchScene,
  createConvertedProfileIndex,
  unpack,
  type ConversionConfig,
} from "./profile";
import { ExteriorFade } from "../model/exteriorFade";
import { createPieceStyle, applyState } from "../model/sketch";
import * as registry from "../models/registry";
import { availablePartIds, powertrainSubclasses } from "../modelSwitcher/powertrains";

afterEach(() => vi.restoreAllMocks());

const config: ConversionConfig = {
  id: "exact_source",
  name: "Exact synthetic source",
  year: 2025,
  series: "Test",
  chassisCode: "TEST",
  bodyType: "sedan",
  forward: "x",
  up: "y",
  unit: "m",
};
function release(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) =>
      m.dispose(),
    );
  });
}

describe("source geometry preservation", () => {
  it("retains the source's exact drawn triangle coordinates through nested transforms and uniform scaling", () => {
    const scene = new THREE.Group();
    const nested = new THREE.Group();
    nested.position.set(8, 3, -12);
    nested.rotation.y = 0.13;
    const source = new THREE.Mesh(new THREE.SphereGeometry(1, 17, 9));
    source.geometry.scale(2.2, 0.7, 0.9);
    source.position.set(0.3, 0.9, 0.1);
    source.name = "paint_body";
    nested.add(source);
    scene.add(nested);
    scene.updateMatrixWorld(true);
    const position = source.geometry.getAttribute("position");
    const originals = Array.from({ length: position.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(source.matrixWorld),
    );
    const box = new THREE.Box3().setFromPoints(originals);
    const centre = box.getCenter(new THREE.Vector3());
    const scale = 4.8 / box.getSize(new THREE.Vector3()).x;
    const profile = convertSketchScene(scene, {
      ...config,
      unit: undefined,
      dimensions: { length: 4.8 },
    });
    const built = buildSourceMesh(profile);
    const expectedIndices = source.geometry.index!;
    let triangleVertex = 0;
    for (const { mesh } of built.pieces) {
      const actual = mesh.geometry.getAttribute("position");
      const indices = mesh.geometry.index!;
      for (let i = 0; i < indices.count; i++) {
        const expected = originals[expectedIndices.getX(triangleVertex++)]!.clone()
          .sub(new THREE.Vector3(centre.x, box.min.y, centre.z))
          .multiplyScalar(scale);
        const point = new THREE.Vector3().fromBufferAttribute(actual, indices.getX(i));
        expect(point.distanceTo(expected)).toBeLessThan(0.000001);
      }
    }
    expect(triangleVertex).toBe(expectedIndices.count);
    expect(built.root.scale.toArray()).toEqual([1, 1, 1]);
    expect(profile.report.warnings.join(" ")).not.toContain(
      "exact exterior contours are not retained",
    );
    const index = createConvertedProfileIndex(profile, "source.json");
    expect(index.partIds).toEqual(["body"]);
    expect(index).not.toHaveProperty("pieces");
    expect(JSON.stringify(index).length).toBeLessThan(JSON.stringify(profile).length);
    expect(() => createConvertedProfileIndex(profile, "../source.json")).toThrow();
    release(scene);
    release(built.root);
  });

  it("maps material groups to source parts, generates local anchors and preserves shape through styling and the assembled exterior fade", () => {
    const scene = new THREE.Group();
    const materials = Array.from({ length: 6 }, (_, i) => {
      const m = new THREE.MeshBasicMaterial();
      m.name = i === 0 ? "CabinGlass" : "BodyPaint";
      return m;
    });
    const source = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 1.8), materials);
    source.position.y = 0.75;
    source.name = "component";
    scene.add(source);
    const profile = convertSketchScene(scene, {
      ...config,
      mappings: [
        { match: "CabinGlass", partId: "windshield", kind: "glass", layer: "exterior" },
        { match: "BodyPaint", partId: "body", kind: "paint", layer: "exterior" },
      ],
    });
    expect(profile.pieces).toHaveLength(6);
    expect(profile.pieces[0]!.partId).toBe("windshield");
    const built = buildSourceMesh(profile);
    expect(built.anchors.has("windshield")).toBe(true);
    vi.spyOn(registry, "getSourceMeshInfoById").mockReturnValue(
      createConvertedProfileIndex(profile, "fixture.json"),
    );
    expect([...availablePartIds("electric", profile.model)].sort()).toEqual(["body", "windshield"]);
    expect(
      powertrainSubclasses("h2", profile.model)
        .flatMap((group) => group.partIds)
        .sort(),
    ).toEqual(["body", "windshield"]);
    const glass = built.pieces[0]!;
    const box = new THREE.Box3().setFromObject(glass.mesh);
    expect(box.min.x).toBeCloseTo(2);
    expect(box.max.x).toBeCloseTo(2);
    const original = glass.mesh.geometry.getAttribute("position").array.slice();
    const palette = {
      background: new THREE.Color("white"),
      ink: new THREE.Color("black"),
      brand: new THREE.Color("blue"),
      selection: new THREE.Color("lightblue"),
    };
    const style = createPieceStyle(glass, palette);
    expect(applyState(glass, style, "selected", 1, palette)).toBe(true);
    const fade = new ExteriorFade("exterior");
    fade.setView("interior", 0);
    fade.update(1000);
    expect(fade.visibility).toBe(0);
    applyState(glass, style, "selected", fade.visibility, palette);
    expect(glass.mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(glass.mesh.geometry.getAttribute("position").array).toEqual(original);
    fade.setView("exterior", 1000);
    fade.update(2000);
    expect(fade.visibility).toBe(1);
    expect(glass.mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(glass.mesh.geometry.getAttribute("position").array).toEqual(original);
    style.fill.dispose();
    style.lines.dispose();
    release(scene);
    release(built.root);
  });

  it("recognizes exported lamps and rear panels while retaining a whole cabin shell without invented selectable parts", () => {
    const scene = new THREE.Group();
    const names = [
      "BMWHeadLightL6_LightGlass_Clear",
      "BMWTailLightR6_LightGlass_Red",
      "SK_Door_BL_101_CarPaint",
      "SM_Bumper_F_101_CarPaint",
      "SM_Bumper_B_101_CarPaint",
      "winsows",
      "InteriorTilling",
      "steering_wheel",
    ];
    for (const [i, name] of names.entries()) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.3));
      mesh.geometry.clearGroups();
      mesh.name = name;
      mesh.position.x = i * 0.5;
      scene.add(mesh);
    }
    const profile = convertSketchScene(scene, config);
    expect(profile.pieces.map((p) => [p.partId, p.kind, p.layer])).toEqual([
      ["headlights", "lamp", "exterior"],
      ["taillights", "tail", "exterior"],
      ["rear_doors", "paint", "exterior"],
      ["front_bumper", "paint", "exterior"],
      ["rear_bumper", "paint", "exterior"],
      ["side_windows", "glass", "exterior"],
      [null, "trim", "interior"],
      ["steering_wheel", "trim", "interior"],
    ]);
    const built = buildSourceMesh(profile);
    const cabin = built.pieces[6]!;
    expect(cabin.mesh.geometry.index!.count).toBe(36);
    expect(createConvertedProfileIndex(profile, "fixture.json").partIds).not.toContain(null);
    release(built.root);
    release(scene);
  });

  it("rejects nonuniform shape changes, invalid mappings and malformed geometry", () => {
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 1.8));
    scene.add(mesh);
    expect(() => convertSketchScene(scene, { ...config, dimensions: { width: 2 } })).toThrow(
      "uniform scaling",
    );
    expect(() =>
      convertSketchScene(scene, {
        ...config,
        mappings: [{ match: "body", partId: "nonexistent_part", kind: "paint", layer: "exterior" }],
      }),
    ).toThrow("Unknown Reqflow part");
    const profile = convertSketchScene(scene, config);
    profile.pieces[0]!.indices = "AAAA";
    expect(() => buildSourceMesh(profile)).toThrow("buffer length");
    expect(unpack("AACAPw==")[0]).toBe(1);
    expect([...partIds].sort()).toEqual(
      [...ALL_CAR_PARTS.map((part) => part.id), WHOLE_CAR.id].sort(),
    );
    release(scene);
  });
});
