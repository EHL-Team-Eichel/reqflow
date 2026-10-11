import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as THREE from "three";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { ConvertedProfileSchema } from "./profile";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../../../../../tools/convert-car.mjs");
const folders: string[] = [];
const config = {
  id: "test_car",
  name: "CLI synthetic car",
  year: 2025,
  series: "Test",
  chassisCode: "TEST",
  bodyType: "sedan",
  forward: "x",
  up: "y",
  unit: "m",
  specialParts: [],
};
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "reqflow-converter-"));
  folders.push(folder);
  const configPath = join(folder, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 1.8));
  mesh.name = "synthetic_body";
  mesh.position.y = 0.75;
  mesh.updateMatrixWorld(true);
  return { folder, configPath, mesh };
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
async function run(input: string, configPath: string, output: string, extra: string[] = []) {
  return execute(process.execPath, [
    "--experimental-strip-types",
    cli,
    "--input",
    input,
    "--config",
    configPath,
    "--output",
    output,
    ...extra,
  ]);
}

describe("converter command", () => {
  it.each(["obj", "stl"])(
    "converts an actual %s file and refuses accidental overwrites",
    async (extension) => {
      const { folder, configPath, mesh } = await fixture();
      const input = join(folder, `car.${extension}`);
      const output = join(folder, "output.json");
      await writeFile(
        input,
        extension === "obj" ? new OBJExporter().parse(mesh) : new STLExporter().parse(mesh),
      );
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      await run(input, configPath, output);
      const result = ConvertedProfileSchema.parse(JSON.parse(await readFile(output, "utf8")));
      expect(result.format).toBe("reqflow-sketch-mesh-v1");
      expect(result.model.dimensions.length).toBeCloseTo(4);
      expect(result.model.dimensions.width).toBeCloseTo(1.8);
      expect(result.model.dimensions.height).toBeCloseTo(1.5);
      const original = await readFile(output, "utf8");
      await expect(run(input, configPath, output)).rejects.toThrow("EEXIST");
      expect(await readFile(output, "utf8")).toBe(original);
      await run(input, configPath, output, ["--force"]);
    },
  );

  it.each(["gltf", "glb"])(
    "reads %s binary buffers and ignores missing textures",
    async (extension) => {
      const { folder, configPath, mesh } = await fixture();
      const positions = mesh.geometry.getAttribute("position");
      const binary = Buffer.from(positions.array.buffer);
      const gltf = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, translation: [2, 1, 3] }],
        meshes: [{ name: "body", primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: positions.count,
            type: "VEC3",
            min: [-2, -0.75, -0.9],
            max: [2, 0.75, 0.9],
          },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
        buffers: [
          { byteLength: binary.length, ...(extension === "gltf" ? { uri: "car.bin" } : {}) },
        ],
        materials: [
          { name: "windshield_glass", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        textures: [{ source: 0 }],
        images: [{ uri: "missing-texture.png" }],
      };
      const input = join(folder, `car.${extension}`);
      if (extension === "gltf") {
        await writeFile(join(folder, "car.bin"), binary);
        await writeFile(input, JSON.stringify(gltf));
      } else {
        const jsonText = JSON.stringify(gltf);
        const json = Buffer.from(
          jsonText + " ".repeat((4 - (Buffer.byteLength(jsonText) % 4)) % 4),
        );
        const header = Buffer.alloc(20);
        header.writeUInt32LE(0x46546c67, 0);
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(28 + json.length + binary.length, 8);
        header.writeUInt32LE(json.length, 12);
        header.writeUInt32LE(0x4e4f534a, 16);
        const binHeader = Buffer.alloc(8);
        binHeader.writeUInt32LE(binary.length, 0);
        binHeader.writeUInt32LE(0x004e4942, 4);
        await writeFile(input, Buffer.concat([header, json, binHeader, binary]));
      }
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      const output = join(folder, "result.json");
      await run(input, configPath, output);
      const result = ConvertedProfileSchema.parse(JSON.parse(await readFile(output, "utf8")));
      expect(result.model.dimensions.length).toBeCloseTo(4);
      expect(result.report.meshCount).toBe(1);
      expect(result.format).toBe("reqflow-sketch-mesh-v1");
      if (result.format === "reqflow-sketch-mesh-v1")
        expect(result.pieces.every((piece) => piece.partId === "windshield")).toBe(true);
      const inspected = await execute(process.execPath, [
        "--experimental-strip-types",
        cli,
        "--input",
        input,
        "--inspect",
      ]);
      expect(JSON.parse(inspected.stdout).meshes).toHaveLength(1);
    },
  );

  it("verifies installed source triangles and rejects changed coordinates or missing pieces", async () => {
    const { folder, configPath, mesh } = await fixture();
    const input = join(folder, "car.obj");
    await writeFile(input, new OBJExporter().parse(new THREE.Group().add(mesh, mesh.clone())));
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    const output = join(folder, `${config.id}.json`);
    await run(input, configPath, output);
    const manifest = join(folder, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        format: "reqflow-catalog-conversion-v1",
        models: [{ input: "car.obj", config }],
      }),
    );
    const verifier = resolve(import.meta.dirname, "../../../../../../tools/verify-car-catalog.mjs");
    const report = join(folder, "report.json");
    const verify = () =>
      execute(process.execPath, [
        "--experimental-strip-types",
        verifier,
        "--manifest",
        manifest,
        "--output",
        folder,
        "--report",
        report,
      ]);
    await verify();
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      ok: true,
      models: 1,
      triangleVertices: 72,
    });
    const original = JSON.parse(await readFile(output, "utf8"));
    const changed = structuredClone(original);
    const positions = Buffer.from(changed.pieces[0].positions, "base64");
    positions.writeFloatLE(positions.readFloatLE(0) + 0.01, 0);
    changed.pieces[0].positions = positions.toString("base64");
    await writeFile(output, JSON.stringify(changed));
    await expect(verify()).rejects.toThrow("Changed source triangle");
    original.pieces.pop();
    await writeFile(output, JSON.stringify(original));
    await expect(verify()).rejects.toThrow("Missing source piece");
  });

  it("fails clearly on compressed geometry and remote buffer URLs", async () => {
    const { folder, configPath, mesh } = await fixture();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    const input = join(folder, "bad.gltf");
    const output = join(folder, "output.json");
    await writeFile(
      input,
      JSON.stringify({
        asset: { version: "2.0" },
        extensionsRequired: ["KHR_draco_mesh_compression"],
      }),
    );
    await expect(run(input, configPath, output)).rejects.toThrow("Compressed Draco/Meshopt");
    await writeFile(
      input,
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "https://example.com/car.bin", byteLength: 8 }],
      }),
    );
    await expect(run(input, configPath, output)).rejects.toThrow("local relative files");
  });
});
