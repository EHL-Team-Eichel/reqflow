#!/usr/bin/env node
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadCarModel } from "./car-model-loader.mjs";
import { writeProfileIndex } from "./profile-index.mjs";
import {
  ConversionConfigSchema,
  ConvertedProfileSchema,
  VehicleProfileSchema,
  convertSketchScene,
} from "../src/renderer/src/components/car/converter/profile.ts";

const modelsDirectory = resolve(import.meta.dirname, "../src/renderer/src/components/car/models");
const basicModelId = "bmw_m5_sedan_g90_2025";
const manifestSchema = z
  .object({
    format: z.literal("reqflow-catalog-conversion-v1"),
    basicModelId: z.literal(basicModelId),
    models: z.array(
      z.object({ input: z.string().min(1).nullable(), config: ConversionConfigSchema }).strict(),
    ),
  })
  .strict();

async function readCatalog() {
  const catalog = [];
  for (const file of (await readdir(modelsDirectory))
    .filter((name) => /^batch\d+\.ts$/.test(name))
    .sort()) {
    const batch = await import(pathToFileURL(join(modelsDirectory, file)).href);
    const key = `BATCH_${file.match(/\d+/)[0]}_MODELS`;
    catalog.push(...z.array(VehicleProfileSchema).parse(batch[key]));
  }
  if (!catalog.some((model) => model.id === basicModelId))
    throw new Error("Basic model missing from catalog");
  if (new Set(catalog.map((model) => model.id)).size !== catalog.length)
    throw new Error("Duplicate catalog IDs");
  return catalog.filter((model) => model.id !== basicModelId);
}

async function sourceFiles(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (
      entry.isFile() &&
      [".glb", ".gltf", ".obj", ".stl"].includes(extname(path).toLowerCase())
    )
      files.push(path);
  }
  return files;
}

async function plan(catalog, output, sources) {
  const files = sources ? await sourceFiles(resolve(sources)) : [];
  const models = catalog.map((model) => {
    const matches = files.filter(
      (file) => file.includes(model.id) || file.includes(model.sketchfabUid),
    );
    return {
      input: matches.length === 1 ? matches[0] : null,
      config: {
        id: model.id,
        name: model.name,
        year: model.year,
        series: model.series,
        chassisCode: model.chassisCode,
        bodyType: model.bodyType,
        powertrain: model.defaultPowertrain,
        supportedPowertrains: [model.defaultPowertrain],
        sourceUrl: `https://sketchfab.com/models/${model.sketchfabUid}`,
        author: "",
        license: "",
        up: "y",
        forward: "-z",
        dimensions: { length: model.dimensions.length },
      },
    };
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ format: "reqflow-catalog-conversion-v1", basicModelId, models }, null, 2) +
      "\n",
    { flag: "wx" },
  );
  console.log(`Prepared ${models.length} replacements; basic M5 preserved.`);
  console.log(
    `${models.filter((model) => model.input).length} source files matched. Fill missing inputs, verify axes/scale, add attribution and license: ${output}`,
  );
}

function isInside(folder, file) {
  const path = relative(folder, file);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
}

async function apply(catalog, manifestPath, output, partial = false) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const expected = new Set(catalog.map((model) => model.id));
  const seen = new Set();
  const missing = [];
  for (const entry of manifest.models) {
    const id = entry.config.id;
    if (id === basicModelId) throw new Error("Basic M5 must not be replaced");
    if (!expected.has(id)) throw new Error(`Unknown catalog ID: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate replacement ID: ${id}`);
    seen.add(id);
    if (!entry.input) missing.push(id);
    if (!entry.config.author.trim() || !entry.config.license.trim())
      throw new Error(`Record source author and license for ${id}`);
  }
  const absent = [...expected].filter((id) => !seen.has(id));
  if (absent.length || (!partial && missing.length))
    throw new Error(
      `All ${catalog.length} non-basic models need source files before replacement (${absent.length} absent entries, ${missing.length} missing inputs)`,
    );
  const replacements = manifest.models.filter((entry) => entry.input);
  if (!replacements.length) throw new Error("No source files are available to convert");
  const replacingIds = new Set(replacements.map((entry) => entry.config.id));
  if (isInside(output, manifestPath))
    throw new Error("Keep manifest outside the imported output folder");
  const inputs = replacements.map((entry) => resolve(dirname(manifestPath), entry.input));
  for (const input of inputs) {
    if (isInside(output, input))
      throw new Error("Keep source geometry outside the imported output folder");
    if (!(await stat(input)).isFile()) throw new Error(`Source is not a file: ${input}`);
  }
  await mkdir(dirname(output), { recursive: true });
  const lock = `${output}.conversion-lock`;
  await writeFile(lock, "Catalog conversion in progress\n", { flag: "wx" });
  let temporary;
  let keepBackup = false;
  try {
    temporary = await mkdtemp(join(dirname(output), ".catalog-conversion-"));
    const staged = join(temporary, "new");
    const backup = join(temporary, "old");
    let existed = false;
    try {
      const info = await stat(output);
      if (!info.isDirectory()) throw new Error("Output must be an imported profile directory");
      existed = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existed) await cp(output, staged, { recursive: true, dereference: true });
    else await mkdir(staged);
    // Remove superseded profiles only in the staging copy; preserve basic/custom entries.
    for (const name of await readdir(staged)) {
      if (!name.endsWith(".json")) continue;
      const existing = ConvertedProfileSchema.parse(
        JSON.parse(await readFile(join(staged, name), "utf8")),
      );
      if (replacingIds.has(existing.model.id)) await rm(join(staged, name));
      if (replacingIds.has(existing.model.id))
        await rm(join(staged, "meta", name), { force: true });
    }
    for (let index = 0; index < replacements.length; index++) {
      const entry = replacements[index];
      const scene = await loadCarModel(inputs[index]);
      try {
        const profile = convertSketchScene(scene, entry.config);
        const target = join(staged, `${profile.model.id}.json`);
        await writeFile(target, JSON.stringify(profile) + "\n", { flag: "wx" });
        await writeProfileIndex(target, profile);
        console.log(`Converted ${index + 1}/${replacements.length}: ${profile.model.id}`);
        for (const warning of profile.report.warnings)
          console.warn(`${profile.model.id}: ${warning}`);
      } finally {
        scene.traverse((object) => {
          if (!object.isMesh) return;
          object.geometry.dispose();
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            material.dispose();
        });
      }
    }
    if (existed) await rename(output, backup);
    try {
      await rename(staged, output);
    } catch (error) {
      if (existed) {
        try {
          await rename(backup, output);
        } catch (restoreError) {
          keepBackup = true;
          throw new Error(
            `Install and restore failed. Original profiles retained at ${backup}: ${restoreError.message}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    console.log(
      `Installed ${replacements.length} source meshes; superseded imported profiles removed; basic M5 preserved. ${catalog.length - replacements.length} non-basic models remain to convert. Rebuild Reqflow to use them.`,
    );
  } finally {
    if (temporary && !keepBackup) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}

const usage = `Convert all non-basic Reqflow models, preserving their source shapes.
Node >= 22.13; run with --experimental-strip-types.
--plan path.json [--sources folder] creates a manifest without changing the app.
--apply path.json [--output folder] validates and converts the complete catalog,
  then replaces imported profiles. Default output: models/imported.
--partial with --apply replaces only entries with downloaded source files.
Source folders/filenames containing a catalog ID or Sketchfab UID match automatically.
Fill every input and confirm each config's axes, scale, source author and license.
The basic M5 is excluded. Incomplete or failed conversions leave current profiles intact.`;

try {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      apply: { type: "string" },
      sources: { type: "string" },
      output: { type: "string" },
      partial: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (Boolean(values.plan) === Boolean(values.apply))
      throw new Error(`Choose --plan or --apply\n${usage}`);
    if ((values.apply && values.sources) || (values.plan && (values.output || values.partial)))
      throw new Error("--sources is for --plan; --output and --partial are for --apply");
    const catalog = await readCatalog();
    if (values.plan) await plan(catalog, resolve(values.plan), values.sources);
    else
      await apply(
        catalog,
        resolve(values.apply),
        resolve(values.output || join(modelsDirectory, "imported")),
        values.partial,
      );
  }
} catch (error) {
  console.error(`Catalog conversion failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
