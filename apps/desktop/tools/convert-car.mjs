#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCarModel } from "./car-model-loader.mjs";
import { writeProfileIndex } from "./profile-index.mjs";
import {
  convertScene,
  convertSketchScene,
} from "../src/renderer/src/components/car/converter/profile.ts";

const usage = `Reqflow car converter (Node >= 22.13)
Usage: node --experimental-strip-types apps/desktop/tools/convert-car.mjs \\
  --input path/to/car.glb --config path/to/car.json --output path/to/profile.json

--inspect prints mesh names and bounds to help configure axes, scale and exclusions.
--force permits replacing an existing output file.
--mode sketch (default) preserves the source mesh; procedural uses the base blueprint.
Download and unpack the Sketchfab model first. Supported: GLB, glTF, OBJ, STL.
Sketch mode retains source geometry and applies Reqflow styling and part mappings.`;

try {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      inspect: { type: "boolean" },
      force: { type: "boolean" },
      mode: { type: "string", default: "sketch" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (!values.input) throw new Error(`--input is required\n${usage}`);
    const scene = await loadCarModel(resolve(values.input));
    if (values.inspect) {
      scene.updateMatrixWorld(true);
      const meshes = [];
      scene.traverse((object) => {
        if (!object.isMesh) return;
        object.geometry.computeBoundingBox();
        const box = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
        meshes.push({
          name: object.name,
          materialHints: [
            object.userData.sourceMaterial,
            object.geometry.userData.sourceMaterial,
            ...(Array.isArray(object.material) ? object.material : [object.material]).map(
              (material) => material.name,
            ),
          ].filter(Boolean),
          vertices: object.geometry.getAttribute("position")?.count,
          min: box.min.toArray(),
          max: box.max.toArray(),
        });
      });
      console.log(JSON.stringify({ meshes }, null, 2));
    } else {
      if (!values.config || !values.output)
        throw new Error(`--config and --output are required\n${usage}`);
      const input = resolve(values.input);
      const configPath = resolve(values.config);
      const output = resolve(values.output);
      if (output === input || output === configPath)
        throw new Error("Output cannot replace input geometry or config");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (!["sketch", "procedural"].includes(values.mode))
        throw new Error("--mode must be sketch or procedural");
      const profile =
        values.mode === "procedural"
          ? convertScene(scene, config)
          : convertSketchScene(scene, config);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(profile, null, 2) + "\n", {
        flag: values.force ? "w" : "wx",
      });
      await writeProfileIndex(output, profile);
      console.log(`Converted ${profile.report.meshCount} meshes → ${output}`);
      console.log(`Dimensions: ${JSON.stringify(profile.model.dimensions)}`);
      for (const warning of profile.report.warnings) console.warn(`Note: ${warning}`);
    }
  }
} catch (error) {
  console.error(`Car conversion failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
