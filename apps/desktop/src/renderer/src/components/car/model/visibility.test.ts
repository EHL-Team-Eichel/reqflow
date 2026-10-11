import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CAR_PARTS } from "../parts";
import { buildCar, type CarPiece, type PieceLayer } from "./buildCar";
import { exteriorBadgeTargets, isPieceVisible, visibleExteriorBadgePoint } from "./visibility";

const car = buildCar();
const testPieces: CarPiece[] = [];

afterAll(() => {
  for (const { mesh } of [...car.pieces, ...testPieces]) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  for (const geometry of car.sketchLines) geometry.dispose();
});

function box(
  partId: string | null,
  position: [number, number, number],
  layer: PieceLayer = "exterior",
) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.position.set(...position);
  mesh.userData.partId = partId;
  mesh.updateMatrixWorld(true);
  const piece: CarPiece = { mesh, partId, kind: "paint", layer };
  testPieces.push(piece);
  return piece;
}

function cameraAt(position: [number, number, number]) {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  camera.position.set(...position);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe("car view visibility", () => {
  it("hides every internal piece in Exterior, irrespective of its material or selection", () => {
    const internal = car.pieces.filter((piece) => piece.layer === "interior");
    expect(internal.length).toBeGreaterThan(0);
    for (const piece of internal) {
      piece.mesh.userData.selected = true;
      expect(isPieceVisible(piece, "exterior")).toBe(false);
    }
  });

  it("keeps externally visible technology, including brakes, the flap and antenna", () => {
    for (const id of ["brakes", "charging_port", "antenna", "driver_assistance"]) {
      const exterior = car.pieces.filter(
        (piece) => piece.partId === id && piece.layer === "exterior",
      );
      expect(exterior.length).toBeGreaterThan(0);
      expect(exterior.every((piece) => isPieceVisible(piece, "exterior"))).toBe(true);
    }
  });

  it("restores every piece in Interior after switching back from Exterior", () => {
    for (const piece of car.pieces) {
      piece.mesh.visible = isPieceVisible(piece, "exterior");
      piece.mesh.visible = isPieceVisible(piece, "interior");
      expect(piece.mesh.visible).toBe(true);
    }
  });

  it("omits cabin, luggage, drivetrain and suspension badge targets in Exterior", () => {
    const targets = exteriorBadgeTargets(car.pieces, car.anchors);
    const internalIds = [
      ...CAR_PARTS.filter((part) => part.group === "interior").map((part) => part.id),
      "drivetrain",
      "suspension",
    ];
    for (const id of internalIds) expect(targets.has(id), id).toBe(false);
    for (const id of ["wheels", "brakes", "charging_port", "antenna", "driver_assistance"])
      expect(targets.has(id), id).toBe(true);
    expect(targets.has("whole_car")).toBe(false);
  });

  it("only adds exterior candidates for a part with both inside and outside sensors", () => {
    const sensorPieces = car.pieces.filter((piece) => piece.partId === "driver_assistance");
    const targets = exteriorBadgeTargets(sensorPieces, car.anchors).get("driver_assistance")!;
    expect(targets).toHaveLength(
      sensorPieces.filter((piece) => piece.layer === "exterior").length + 1,
    );
    expect(sensorPieces.some((piece) => piece.layer === "interior")).toBe(true);
  });
});

describe("exterior badge occlusion", () => {
  const raycaster = new THREE.Raycaster();

  it("places the badge on a visible surface instead of its anchor inside the solid", () => {
    const piece = box("hood", [0, 0, 0]);
    const anchor = new THREE.Vector3();
    const point = visibleExteriorBadgePoint(
      "hood",
      [anchor],
      cameraAt([0, 0, 5]),
      [piece.mesh],
      raycaster,
    );
    expect(point?.z).toBeCloseTo(0.5);
    expect(anchor.z).toBe(0);
  });

  it("hides a point covered by another part, then reveals it after orbiting", () => {
    const front = box("body", [0, 0, 1]);
    const back = box("charging_port", [0, 0, -1]);
    const targets = exteriorBadgeTargets([front, back], new Map()).get("charging_port")!;
    const surfaces = [front.mesh, back.mesh];
    expect(
      visibleExteriorBadgePoint("charging_port", targets, cameraAt([0, 0, 5]), surfaces, raycaster),
    ).toBeNull();
    expect(
      visibleExteriorBadgePoint("charging_port", targets, cameraAt([0, 0, -5]), surfaces, raycaster)
        ?.z,
    ).toBeCloseTo(-1.5);
  });

  it("tries a visible opposite-side mesh when the preferred anchor is blocked", () => {
    const body = box("body", [0, 0, 0]);
    const left = box("mirrors", [-1, 0, 0]);
    const right = box("mirrors", [1, 0, 0]);
    const anchor = new THREE.Vector3(-1, 0, 0);
    const surfaces = [body.mesh, left.mesh, right.mesh];
    const camera = cameraAt([5, 0, 0]);
    // The ray to the preferred anchor misses the right mirror and is blocked by the body.
    left.mesh.position.y = 0.45;
    right.mesh.position.y = -0.45;
    left.mesh.updateMatrixWorld(true);
    right.mesh.updateMatrixWorld(true);
    anchor.y = 0.45;
    expect(visibleExteriorBadgePoint("mirrors", [anchor], camera, surfaces, raycaster)).toBeNull();
    const targets = exteriorBadgeTargets([left, right], new Map([["mirrors", anchor]])).get(
      "mirrors",
    )!;
    expect(
      visibleExteriorBadgePoint("mirrors", targets, camera, surfaces, raycaster)?.x,
    ).toBeCloseTo(1.5);
  });

  it("does not look through a non-interactive wheel-well shield", () => {
    const shield = box(null, [0, 0, 1]);
    const brake = box("brakes", [0, 0, -1]);
    expect(
      visibleExteriorBadgePoint(
        "brakes",
        [brake.mesh.position],
        cameraAt([0, 0, 5]),
        [shield.mesh, brake.mesh],
        raycaster,
      ),
    ).toBeNull();
  });

  it.each([
    [0, 0, 6],
    [10, 0, 0],
    [0, 10, 0],
    [0, 0, -101],
  ] as [number, number, number][])(
    "hides offscreen or clipped targets at (%s, %s, %s)",
    (x, y, z) => {
      const piece = box("hood", [x, y, z]);
      expect(
        visibleExteriorBadgePoint(
          "hood",
          [piece.mesh.position],
          cameraAt([0, 0, 5]),
          [piece.mesh],
          raycaster,
        ),
      ).toBeNull();
    },
  );

  it("hides missing targets and anchors whose ray misses the model", () => {
    const piece = box("hood", [0, 0, 0]);
    const camera = cameraAt([0, 0, 5]);
    expect(visibleExteriorBadgePoint("hood", [], camera, [piece.mesh], raycaster)).toBeNull();
    expect(
      visibleExteriorBadgePoint(
        "hood",
        [new THREE.Vector3(1, 0, 0)],
        camera,
        [piece.mesh],
        raycaster,
      ),
    ).toBeNull();
  });
});
