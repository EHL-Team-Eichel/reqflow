import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { BUILT_IN_VEHICLE_MODELS } from "../models/registry";
import {
  ConvertedProfileSchema,
  createConvertedProfileIndex,
  convertSketchScene,
  type ConversionConfig,
} from "./profile";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../../../../../tools/convert-car-catalog.mjs");
const folders: string[] = [];
// The protected procedural model is independent of the default preview selection.
const BASIC_MODEL_ID = "bmw_m5_sedan_g90_2025";
async function run(...args: string[]) {
  return execute(process.execPath, ["--experimental-strip-types", cli, ...args], {
    maxBuffer: 4_000_000,
  });
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "reqflow-catalog-"));
  folders.push(folder);
  const manifestPath = join(folder, "manifest.json");
  await run("--plan", manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    format: string;
    basicModelId: string;
    models: { input: string | null; config: ConversionConfig }[];
  };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 1.8));
  mesh.name = "body";
  const input = join(folder, "synthetic.obj");
  await writeFile(input, new OBJExporter().parse(mesh));
  for (const entry of manifest.models) {
    entry.input = "synthetic.obj";
    entry.config.forward = "x";
    entry.config.author = "Synthetic fixture";
    entry.config.license = "Synthetic test data";
  }
  const output = join(folder, "imported");
  await mkdir(output);
  const old = convertSketchScene(mesh, manifest.models[0]!.config);
  const oldText = JSON.stringify(old);
  await writeFile(join(output, "old-version.json"), oldText);
  const basicText = JSON.stringify({ ...old, model: { ...old.model, id: BASIC_MODEL_ID } });
  await writeFile(join(output, "basic.json"), basicText);
  const customText = JSON.stringify({ ...old, model: { ...old.model, id: "custom_car" } });
  await writeFile(join(output, "custom.json"), customText);
  await writeFile(join(output, ".gitkeep"), "");
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  return { folder, manifestPath, manifest, output, basicText, customText, oldText };
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("whole catalog source replacement", () => {
  it("can install available sources without removing models whose downloads are pending", async () => {
    const f = await fixture();
    const convertedId = f.manifest.models[1]!.config.id;
    for (const entry of f.manifest.models) {
      if (entry.config.id !== convertedId) entry.input = null;
    }
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const result = await run("--apply", f.manifestPath, "--output", f.output, "--partial");
    expect(result.stdout).toContain("103 non-basic models remain");
    expect(await readFile(join(f.output, "old-version.json"), "utf8")).toBe(f.oldText);
    expect(await readFile(join(f.output, "basic.json"), "utf8")).toBe(f.basicText);
    const profile = ConvertedProfileSchema.parse(
      JSON.parse(await readFile(join(f.output, `${convertedId}.json`), "utf8")),
    );
    expect(profile.format).toBe("reqflow-sketch-mesh-v1");
  });
  it("plans every non-basic ID without changing models and finds UID-named files", async () => {
    const f = await fixture();
    expect(f.manifest.basicModelId).toBe(BASIC_MODEL_ID);
    expect(f.manifest.models.map((entry) => entry.config.id).sort()).toEqual(
      BUILT_IN_VEHICLE_MODELS.filter((model) => model.id !== BASIC_MODEL_ID)
        .map((model) => model.id)
        .sort(),
    );
    expect(f.manifest.models).toHaveLength(104);
    const matched = BUILT_IN_VEHICLE_MODELS.find((model) => model.id !== BASIC_MODEL_ID)!;
    await writeFile(
      join(f.folder, `${matched.sketchfabUid}.obj`),
      await readFile(join(f.folder, "synthetic.obj")),
    );
    const plan = join(f.folder, "matched.json");
    await run("--plan", plan, "--sources", f.folder);
    const result = JSON.parse(await readFile(plan, "utf8"));
    expect(
      result.models.find((entry: { config: { id: string } }) => entry.config.id === matched.id)
        .input,
    ).toBe(join(f.folder, `${matched.sketchfabUid}.obj`));
    expect(await readFile(join(f.output, "old-version.json"), "utf8")).toBe(f.oldText);
    await expect(run("--plan", plan)).rejects.toThrow("EEXIST");
  });

  it("installs complete source profiles, removes superseded versions and preserves the basic model", async () => {
    const f = await fixture();
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const sourceBefore = await readFile(join(f.folder, "synthetic.obj"), "utf8");
    await run("--apply", f.manifestPath, "--output", f.output);
    const files = await readdir(f.output);
    expect(files).not.toContain("old-version.json");
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(106);
    expect(await readFile(join(f.output, "basic.json"), "utf8")).toBe(f.basicText);
    expect(await readFile(join(f.output, "custom.json"), "utf8")).toBe(f.customText);
    expect(files).toContain(".gitkeep");
    for (const entry of f.manifest.models) {
      const profile = ConvertedProfileSchema.parse(
        JSON.parse(await readFile(join(f.output, `${entry.config.id}.json`), "utf8")),
      );
      expect(profile.format).toBe("reqflow-sketch-mesh-v1");
      expect(profile.model.id).toBe(entry.config.id);
      expect(profile.model.dimensions.width / profile.model.dimensions.length).toBeCloseTo(1.8 / 4);
      const file = `${entry.config.id}.json`;
      expect(JSON.parse(await readFile(join(f.output, "meta", file), "utf8"))).toEqual(
        createConvertedProfileIndex(profile, file),
      );
    }
    expect(await readFile(join(f.folder, "synthetic.obj"), "utf8")).toBe(sourceBefore);
  });

  it("leaves every old profile intact when inputs are incomplete or a late conversion fails", async () => {
    const f = await fixture();
    f.manifest.models[0]!.input = null;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    await expect(run("--apply", f.manifestPath, "--output", f.output)).rejects.toThrow(
      "missing inputs",
    );
    f.manifest.models[0]!.input = "synthetic.obj";
    f.manifest.models.at(-1)!.input = "invalid.obj";
    await writeFile(join(f.folder, "invalid.obj"), "# no geometry\n");
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    await expect(run("--apply", f.manifestPath, "--output", f.output)).rejects.toThrow(
      "Catalog conversion failed",
    );
    expect((await readdir(f.output)).sort()).toEqual([
      ".gitkeep",
      "basic.json",
      "custom.json",
      "old-version.json",
    ]);
    expect(await readFile(join(f.output, "old-version.json"), "utf8")).toBe(f.oldText);
    expect(await readFile(join(f.output, "basic.json"), "utf8")).toBe(f.basicText);
    expect(
      (await readdir(f.folder)).some(
        (name) => name.startsWith(".catalog-conversion-") || name.endsWith(".conversion-lock"),
      ),
    ).toBe(false);
  });

  it("rejects manifests that try to replace the basic model or repeat another ID", async () => {
    const f = await fixture();
    const originalId = f.manifest.models[0]!.config.id;
    f.manifest.models[0]!.config.id = BASIC_MODEL_ID;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    await expect(run("--apply", f.manifestPath, "--output", f.output)).rejects.toThrow(
      "Basic M5 must not be replaced",
    );
    f.manifest.models[0]!.config.id = originalId;
    f.manifest.models[1]!.config.id = originalId;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    await expect(run("--apply", f.manifestPath, "--output", f.output)).rejects.toThrow(
      "Duplicate replacement ID",
    );
    expect(await readFile(join(f.output, "basic.json"), "utf8")).toBe(f.basicText);
  });
});
