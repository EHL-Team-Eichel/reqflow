import * as THREE from "three";
import type { CarPiece, PieceLayer } from "./buildCar";

export type CarView = PieceLayer;

export function isPieceVisible(piece: CarPiece, view: CarView): boolean {
  return view === "interior" || piece.layer === "exterior";
}

/** Preferred anchors plus per-piece centres, so badges can follow either side of the car. */
export function exteriorBadgeTargets(
  pieces: readonly CarPiece[],
  anchors: ReadonlyMap<string, THREE.Vector3>,
): ReadonlyMap<string, readonly THREE.Vector3[]> {
  const targets = new Map<string, THREE.Vector3[]>();
  for (const piece of pieces) {
    if (!isPieceVisible(piece, "exterior") || !piece.partId) continue;
    let points = targets.get(piece.partId);
    if (!points) {
      const anchor = anchors.get(piece.partId);
      points = anchor ? [anchor] : [];
      targets.set(piece.partId, points);
    }
    piece.mesh.geometry.computeBoundingBox();
    points.push(
      piece.mesh.geometry
        .boundingBox!.getCenter(new THREE.Vector3())
        .applyMatrix4(piece.mesh.matrixWorld),
    );
  }
  return targets;
}

/** A badge belongs on the first visible surface, never on an internal or far-side anchor. */
export function visibleExteriorBadgePoint(
  partId: string,
  targets: readonly THREE.Vector3[],
  camera: THREE.Camera,
  surfaces: THREE.Mesh[],
  raycaster: THREE.Raycaster,
  reviewArea = false,
): THREE.Vector3 | null {
  const projected = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  for (const target of targets) {
    projected.copy(target).project(camera);
    if (
      projected.z <= -1 ||
      projected.z >= 1 ||
      Math.abs(projected.x) >= 1 ||
      Math.abs(projected.y) >= 1
    )
      continue;
    pointer.set(projected.x, projected.y);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(surfaces, false)[0];
    if (
      hit &&
      (reviewArea ? hit.point.distanceTo(target) < 0.08 : hit.object.userData.partId === partId)
    )
      return hit.point;
  }
  return null;
}
