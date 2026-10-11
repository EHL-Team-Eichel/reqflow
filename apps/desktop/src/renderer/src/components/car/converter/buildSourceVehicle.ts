import * as THREE from "three";
import type { CarModel, CarPiece } from "../model/buildCar";
import { buildVehicleModel } from "../models/builder";
import type { PowertrainType, VehicleModel } from "../models/types";
import { buildSourceMesh } from "./buildSourceMesh";
import type { SourceMeshProfile } from "./profile";
import { sourceReviewAreaTargets } from "./sourceReviewAreas";

/**
 * Builds an imported car from its exact source exterior and Reqflow's standard cabin and
 * chassis. Standard interior transforms are baked into their geometry so the returned root stays
 * at identity, as required by the imported source mesh.
 */
export function buildSourceVehicle(
  profile: SourceMeshProfile,
  powertrain: PowertrainType = profile.model.defaultPowertrain,
): CarModel {
  const source = buildSourceMesh(profile);
  let standard: CarModel | undefined;
  try {
    standard = buildVehicleModel(profile.model, powertrain);

    const sourceExterior = source.pieces.filter((piece) => piece.layer === "exterior");
    const sourceInterior = source.pieces.filter((piece) => piece.layer === "interior");
    const standardInterior = standard.pieces.filter((piece) => piece.layer === "interior");
    const standardExterior = standard.pieces.filter((piece) => piece.layer === "exterior");
    const retainedMeshes = [...sourceExterior, ...standardInterior].map((piece) => piece.mesh);

    standard.root.updateMatrixWorld(true);
    for (const piece of standardInterior) {
      const { mesh } = piece;
      mesh.updateWorldMatrix(true, false);
      const baked = mesh.geometry.clone();
      baked.applyMatrix4(mesh.matrixWorld);
      mesh.geometry.dispose();
      mesh.geometry = baked;
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.updateMatrix();
      mesh.matrixWorld.identity();
      mesh.matrixWorldNeedsUpdate = true;
      standard.root.remove(mesh);
      source.root.add(mesh);
    }

    for (const piece of sourceInterior) source.root.remove(piece.mesh);
    for (const piece of standardExterior) standard.root.remove(piece.mesh);

    const exteriorAnchors = anchorsForPieces(sourceExterior);
    const anchors = new Map(
      [...exteriorAnchors].map(([id, anchor]) => [id, anchor.clone()] as const),
    );
    const exteriorReviewAreas = sourceReviewAreaTargets(
      profile.model,
      sourceExterior.map((piece) => piece.mesh),
    );
    for (const [id, points] of exteriorReviewAreas) {
      exteriorAnchors.set(id, points[0]!.clone());
      anchors.set(id, points[0]!.clone());
    }
    const standardInteriorIds = new Set(
      standardInterior.flatMap((piece) => (piece.partId ? [piece.partId] : [])),
    );
    // Keep the standard model's badge placement for retained cabin/chassis parts, including IDs
    // that also have a source exterior anchor. The viewer can use exteriorAnchors separately.
    for (const id of standardInteriorIds) {
      const anchor = standard.anchors.get(id);
      if (anchor) anchors.set(id, anchor.clone());
    }

    const pieces = [...sourceExterior, ...standardInterior];
    source.root.name = `${profile.model.name} (${profile.model.chassisCode}) — source exterior + standard interior (${powertrain})`;
    source.root.position.set(0, 0, 0);
    source.root.rotation.set(0, 0, 0);
    source.root.scale.set(1, 1, 1);
    source.root.updateMatrixWorld(true);

    disposeUnusedPieces([...sourceInterior, ...standardExterior], retainedMeshes);
    disposeLines(source.sketchLines);
    disposeLines(standard.sketchLines);

    return {
      root: source.root,
      pieces,
      sketchLines: [],
      anchors,
      exteriorAnchors,
      exteriorReviewAreas,
    };
  } catch (error) {
    if (standard) disposeCarModels([source, standard]);
    else disposeCarModels([source]);
    throw error;
  }
}

const interiorIdsByModel = new WeakMap<VehicleModel, Map<PowertrainType, readonly string[]>>();

/**
 * Returns only part IDs that the standard builder actually renders on the model's interior and
 * chassis for this powertrain. The temporary geometry is disposed immediately; only IDs are
 * cached, so menus can call this without retaining a second car model.
 */
export function standardInteriorPartIds(model: VehicleModel, powertrain: PowertrainType): string[] {
  let byPowertrain = interiorIdsByModel.get(model);
  if (!byPowertrain) {
    byPowertrain = new Map();
    interiorIdsByModel.set(model, byPowertrain);
  }
  const cached = byPowertrain.get(powertrain);
  if (cached) return [...cached];

  const standard = buildVehicleModel(model, powertrain);
  try {
    const ids = [
      ...new Set(
        standard.pieces
          .filter((piece) => piece.layer === "interior")
          .flatMap((piece) => (piece.partId ? [piece.partId] : [])),
      ),
    ].sort();
    byPowertrain.set(powertrain, ids);
    return [...ids];
  } finally {
    disposeCarModels([standard]);
  }
}

function anchorsForPieces(pieces: readonly CarPiece[]): Map<string, THREE.Vector3> {
  const boxes = new Map<string, THREE.Box3>();
  const point = new THREE.Vector3();
  for (const { mesh, partId } of pieces) {
    if (!partId) continue;
    const positions = mesh.geometry.getAttribute("position");
    if (!positions) continue;
    const box = boxes.get(partId) ?? new THREE.Box3();
    mesh.updateWorldMatrix(true, false);
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
    boxes.set(partId, box);
  }

  const anchors = new Map<string, THREE.Vector3>();
  for (const [id, box] of boxes) {
    const anchor = box.getCenter(new THREE.Vector3());
    anchor.y = box.max.y + 0.04;
    anchors.set(id, anchor);
  }
  return anchors;
}

function disposeUnusedPieces(pieces: readonly CarPiece[], retained: readonly THREE.Mesh[]): void {
  const retainedGeometries = new Set(retained.map((mesh) => mesh.geometry));
  const retainedMaterials = new Set<THREE.Material>();
  for (const mesh of retained) {
    for (const material of materialsOf(mesh)) retainedMaterials.add(material);
  }
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  for (const { mesh } of pieces) {
    if (!retainedGeometries.has(mesh.geometry) && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    for (const material of materialsOf(mesh)) {
      if (!retainedMaterials.has(material) && !disposedMaterials.has(material)) {
        disposedMaterials.add(material);
        material.dispose();
      }
    }
  }
}

function disposeCarModels(models: readonly CarModel[]): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const model of models) {
    for (const { mesh } of model.pieces) {
      geometries.add(mesh.geometry);
      for (const material of materialsOf(mesh)) materials.add(material);
    }
    for (const line of model.sketchLines) geometries.add(line);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function disposeLines(lines: readonly THREE.BufferGeometry[]): void {
  for (const geometry of new Set(lines)) geometry.dispose();
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
