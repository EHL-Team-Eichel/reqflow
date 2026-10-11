import * as THREE from "three";
import type { CarModel, CarPiece } from "../model/buildCar";
import { ALL_CAR_PARTS, WHOLE_CAR } from "../parts";
import { SourceMeshProfileSchema, unpack, type SourceMeshProfile } from "./profile";

/** Builds the imported geometry in the same CarModel contract used by the base car. */
export function buildSourceMesh(input: SourceMeshProfile): CarModel {
  const profile = SourceMeshProfileSchema.parse(input);
  const root = new THREE.Group();
  root.name = `${profile.model.name} — source mesh sketch`;
  const pieces: CarPiece[] = [];
  const boxes = new Map<string, THREE.Box3>();
  const partIds = new Set([...ALL_CAR_PARTS.map((part) => part.id), WHOLE_CAR.id]);
  try {
    for (const piece of profile.pieces) {
      if (piece.partId && !partIds.has(piece.partId))
        throw new Error(`Unknown Reqflow part id '${piece.partId}' on source mesh '${piece.name}'`);
      const positions = unpack(piece.positions) as Float32Array;
      const normals = unpack(piece.normals) as Float32Array;
      const indices = unpack(piece.indices, true) as Uint32Array;
      if (
        positions.length % 3 ||
        normals.length !== positions.length ||
        indices.length % 3 ||
        !positions.every(Number.isFinite) ||
        !normals.every(Number.isFinite) ||
        !indices.every((index) => index < positions.length / 3)
      )
        throw new Error(`Invalid geometry buffers on source mesh '${piece.name}'`);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.userData.sourceMesh = true;
      const mesh = new THREE.Mesh(geometry);
      mesh.name = piece.name;
      mesh.userData.partId = piece.partId;
      root.add(mesh);
      pieces.push({ mesh, partId: piece.partId, kind: piece.kind, layer: piece.layer });
      if (piece.partId) {
        const box = boxes.get(piece.partId) ?? new THREE.Box3();
        const point = new THREE.Vector3();
        for (const index of indices)
          box.expandByPoint(point.fromBufferAttribute(geometry.getAttribute("position"), index));
        boxes.set(piece.partId, box);
      }
    }
  } catch (error) {
    for (const { mesh } of pieces) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    throw error;
  }
  const anchors = new Map<string, THREE.Vector3>();
  for (const [id, box] of boxes) {
    const anchor = box.getCenter(new THREE.Vector3());
    anchor.y = box.max.y + 0.04;
    anchors.set(id, anchor);
  }
  root.updateMatrixWorld(true);
  return { root, pieces, anchors, sketchLines: [] };
}
