import * as THREE from "three";
import type { VehicleModel } from "../models/types";

type AreaSide = "front" | "rear" | "side" | "top";
interface ReviewArea {
  id: string;
  side: AreaSide;
  /** Fractions of measured length, height and width; these locate review areas, not new meshes. */
  position: readonly [number, number, number];
}

const M4_AREAS: readonly ReviewArea[] = [
  // The source's grille material is a broad/occluded assembly; anchor its existing review ID at the face.
  { id: "kidney_grille", side: "front", position: [0, 0.45, 0.14] },
  { id: "headlights", side: "front", position: [0, 0.52, 0.34] },
  { id: "front_bumper", side: "front", position: [0, 0.23, 0.38] },
  { id: "windshield", side: "top", position: [0.145, 0, 0.12] },
  { id: "roof", side: "top", position: [-0.05, 0, 0.12] },
  { id: "door_handles", side: "side", position: [-0.11, 0.6, 0] },
  { id: "mirrors", side: "side", position: [0.125, 0.75, 0] },
  { id: "rear_window", side: "top", position: [-0.235, 0, 0.12] },
  { id: "trunk_lid", side: "top", position: [-0.38, 0, 0.12] },
  { id: "taillights", side: "rear", position: [0, 0.55, 0.34] },
  { id: "rear_bumper", side: "rear", position: [0, 0.24, 0.31] },
];

/** Supplement the imported M4's broad source assemblies with the sedan's exterior review vocabulary. */
export function sourceReviewAreaIds(model: VehicleModel): string[] {
  return model.id === "bmw_m4_competition_2025" ? M4_AREAS.map((area) => area.id) : [];
}

/** Project paired review points onto the real exterior; never add, move or replace source geometry. */
export function sourceReviewAreaTargets(
  model: VehicleModel,
  surfaces: THREE.Mesh[],
): Map<string, readonly THREE.Vector3[]> {
  const targets = new Map<string, readonly THREE.Vector3[]>();
  if (model.id !== "bmw_m4_competition_2025") return targets;
  const { length, height, width } = model.dimensions;
  const raycaster = new THREE.Raycaster();
  for (const mesh of surfaces) mesh.updateWorldMatrix(true, false);
  for (const area of M4_AREAS) {
    const points: THREE.Vector3[] = [];
    for (const sign of [-1, 1]) {
      const [x, y, z] = area.position;
      const origin = new THREE.Vector3(x * length, y * height, sign * z * width);
      const direction = new THREE.Vector3();
      switch (area.side) {
        case "front":
          origin.x = length / 2 + 0.5;
          direction.x = -1;
          break;
        case "rear":
          origin.x = -length / 2 - 0.5;
          direction.x = 1;
          break;
        case "side":
          origin.z = sign * (width / 2 + 0.5);
          direction.z = -sign;
          break;
        case "top":
          origin.y = height + 0.5;
          direction.y = -1;
          break;
      }
      raycaster.set(origin, direction);
      const hit = raycaster.intersectObjects(surfaces, false)[0];
      if (hit) points.push(hit.point.clone());
    }
    if (!points.length) throw new Error(`Could not locate M4 exterior review area '${area.id}'.`);
    targets.set(area.id, points);
  }
  return targets;
}
