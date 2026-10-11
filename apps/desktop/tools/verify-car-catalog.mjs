#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as THREE from "three";
import { loadCarModel } from "./car-model-loader.mjs";
import {
  ConversionConfigSchema,
  SourceMeshProfileSchema,
  unpack,
} from "../src/renderer/src/components/car/converter/profile.ts";

function axis(name) {
  const value = new THREE.Vector3();
  value.setComponent("xyz".indexOf(name.at(-1)), name.startsWith("-") ? -1 : 1);
  return value;
}

async function verify(entry, manifestPath, output) {
  const config = ConversionConfigSchema.parse(entry.config);
  const source = await loadCarModel(resolve(dirname(manifestPath), entry.input));
  try {
    source.updateMatrixWorld(true);
    const forward = axis(config.forward),
      up = axis(config.up);
    const right = forward.clone().cross(up);
    // Independent coordinate projection of the original world-space vertices.
    const project = (point) =>
      new THREE.Vector3(point.dot(forward), point.dot(up), point.dot(right));
    const meshes = [];
    const bounds = new THREE.Box3();
    source.traverse((object) => {
      if (!object.isMesh) return;
      const names = [];
      for (let p = object; p && p !== source; p = p.parent) names.push(p.name);
      if (
        config.excludeMeshes.some((text) =>
          names.join(" ").toLowerCase().includes(text.toLowerCase()),
        )
      )
        return;
      const position = object.geometry.getAttribute("position");
      if (!position?.count) return;
      const points = Array.from({ length: position.count }, (_, i) =>
        project(
          new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld),
        ),
      );
      for (const point of points) bounds.expandByPoint(point);
      meshes.push({ object, points });
    });
    const profile = SourceMeshProfileSchema.parse(
      JSON.parse(await readFile(resolve(output, `${config.id}.json`), "utf8")),
    );
    if (profile.model.id !== config.id) throw new Error(`Wrong profile ID: ${config.id}`);
    const scale = config.dimensions.length
      ? config.dimensions.length / bounds.getSize(new THREE.Vector3()).x
      : { m: 1, cm: 0.01, mm: 0.001 }[config.unit];
    const center = bounds.getCenter(new THREE.Vector3());
    const origin = new THREE.Vector3(center.x, bounds.min.y, center.z);
    let pieceNumber = 0,
      vertices = 0,
      maxError = 0;
    for (const { object, points } of meshes) {
      const geometry = object.geometry,
        count = geometry.index?.count ?? points.length;
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count }];
      for (const group of groups) {
        const start = Math.max(group.start, geometry.drawRange.start);
        const end = Math.min(
          group.start + group.count,
          count,
          geometry.drawRange.start + geometry.drawRange.count,
        );
        if (start >= end) continue;
        const piece = profile.pieces[pieceNumber++];
        if (!piece) throw new Error(`Missing source piece: ${config.id}`);
        const positions = unpack(piece.positions),
          indices = unpack(piece.indices, true);
        if (indices.length !== end - start) throw new Error(`Changed triangle count: ${config.id}`);
        for (let i = 0; i < indices.length; i++) {
          let original = start + i;
          if (object.matrixWorld.determinant() < 0 && i % 3 !== 0) original += i % 3 === 1 ? 1 : -1;
          const expected = points[geometry.index?.getX(original) ?? original]
            .clone()
            .sub(origin)
            .multiplyScalar(scale);
          const actual = new THREE.Vector3().fromArray(positions, indices[i] * 3);
          const error = actual.distanceTo(expected);
          if (!Number.isFinite(error) || error > 1e-6)
            throw new Error(`Changed source triangle in ${config.id}: error ${error} m`);
          maxError = Math.max(maxError, error);
          vertices++;
        }
      }
    }
    if (pieceNumber !== profile.pieces.length) throw new Error(`Added source pieces: ${config.id}`);
    return {
      id: config.id,
      pieces: pieceNumber,
      triangleVertices: vertices,
      maxCoordinateErrorMetres: maxError,
    };
  } finally {
    source.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        material.dispose();
    });
  }
}

try {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
    },
  });
  if (!values.manifest)
    throw new Error(
      "Usage: --manifest plan.json [--output imported-folder] [--report report.json]",
    );
  const manifestPath = resolve(values.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "reqflow-catalog-conversion-v1" || !Array.isArray(manifest.models))
    throw new Error("Invalid catalog manifest");
  const output = resolve(
    values.output ??
      resolve(import.meta.dirname, "../src/renderer/src/components/car/models/imported"),
  );
  const results = [];
  for (const entry of manifest.models.filter((entry) => entry.input)) {
    results.push(await verify(entry, manifestPath, output));
    console.log(`Verified ${results.length}: ${entry.config.id}`);
  }
  if (!results.length) throw new Error("No source files to verify");
  const report = {
    ok: true,
    models: results.length,
    triangleVertices: results.reduce((n, r) => n + r.triangleVertices, 0),
    maxCoordinateErrorMetres: Math.max(...results.map((r) => r.maxCoordinateErrorMetres)),
    results,
  };
  if (values.report)
    await writeFile(resolve(values.report), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `All ${report.models} models preserve ${report.triangleVertices} drawn triangle vertices; maximum error ${report.maxCoordinateErrorMetres} m.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
