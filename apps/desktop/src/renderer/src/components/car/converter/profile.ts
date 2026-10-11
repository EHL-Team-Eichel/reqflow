import * as THREE from "three";
import { z } from "zod";
import partIds from "./partIds.json" with { type: "json" };
import type { VehicleModel, CarSpecialPart } from "../models/types";

const positive = z.number().finite().positive();
const powertrain = z.enum(["electric", "hybrid", "h2", "gasoline"]);
const bodyType = z.enum([
  "sedan",
  "coupe",
  "touring",
  "suv",
  "convertible",
  "gran_coupe",
  "race",
  "concept",
  "roadster",
  "hatchback",
]);
const specialPart = z.enum([
  "rear_spoiler",
  "duckbill_spoiler",
  "gt_wing",
  "front_splitter",
  "canards",
  "widebody_flares",
  "rear_diffuser",
  "roll_cage",
  "roof_rails",
  "skid_plates",
  "convertible_roof",
  "hood_vents",
  "exhaust_system",
  "fuel_system",
  "h2_storage",
  "combustion_engine",
  "fuel_cell",
]);
const dimensionFields = {
  length: positive,
  width: positive,
  height: positive,
  wheelbase: positive,
  frontAxleX: z.number().finite(),
  rearAxleX: z.number().finite(),
  track: positive,
  tyreRadius: positive,
  tyreWidth: positive,
  groundClearance: z.number().finite().nonnegative(),
};
export const VehicleProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    name: z.string().min(1),
    sketchfabUid: z.string().regex(/^([a-f0-9]{32})?$/),
    year: z.number().int().min(1886).max(2200),
    series: z.string().min(1),
    chassisCode: z.string().min(1),
    bodyType,
    defaultPowertrain: powertrain,
    supportedPowertrains: z.array(powertrain).min(1),
    dimensions: z.object(dimensionFields),
    specialParts: z.array(specialPart),
    description: z.string(),
  })
  .superRefine((model, ctx) => {
    const d = model.dimensions;
    if (!model.supportedPowertrains.includes(model.defaultPowertrain))
      ctx.addIssue({ code: "custom", message: "Default powertrain must be supported" });
    if (d.frontAxleX <= d.rearAxleX || Math.abs(d.frontAxleX - d.rearAxleX - d.wheelbase) > 0.002)
      ctx.addIssue({ code: "custom", message: "Axle positions must agree with wheelbase" });
    if (
      d.wheelbase >= d.length ||
      Math.max(Math.abs(d.frontAxleX), Math.abs(d.rearAxleX)) >= d.length / 2
    )
      ctx.addIssue({ code: "custom", message: "Axles must lie inside the vehicle length" });
    if (d.track + d.tyreWidth > d.width * 1.1 || d.tyreRadius * 2 >= d.height)
      ctx.addIssue({
        code: "custom",
        message: "Wheel dimensions are inconsistent with body dimensions",
      });
  });

const axis = z.enum(["x", "y", "z", "-x", "-y", "-z"]);
const partIdSchema = z
  .string()
  .refine((value) => partIds.includes(value), "Unknown Reqflow part id")
  .nullable();
const pieceKind = z.enum([
  "paint",
  "glass",
  "dark",
  "chrome",
  "lamp",
  "tail",
  "tyre",
  "rim",
  "metal",
  "accent",
  "trim",
  "seat",
  "screen",
  "glow",
  "volume",
  "liner",
]);
const mappingSchema = z
  .object({
    match: z.string().min(1),
    partId: partIdSchema,
    kind: pieceKind,
    layer: z.enum(["exterior", "interior"]),
  })
  .strict();
export const ConversionConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    name: z.string().min(1),
    year: z.number().int().min(1886).max(2200),
    series: z.string().min(1),
    chassisCode: z.string().min(1),
    bodyType,
    powertrain: powertrain.default("gasoline"),
    supportedPowertrains: z.array(powertrain).min(1).optional(),
    sourceUrl: z.url().optional(),
    author: z.string().default(""),
    license: z.string().default(""),
    up: axis.default("y"),
    forward: axis.default("-z"),
    unit: z.enum(["m", "cm", "mm"]).optional(),
    dimensions: z.object(dimensionFields).partial().default({}),
    specialParts: z.array(specialPart).optional(),
    excludeMeshes: z.array(z.string().min(1)).default([]),
    mappings: z.array(mappingSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.up.replace("-", "") === config.forward.replace("-", ""))
      ctx.addIssue({ code: "custom", message: "Up and forward must use different axes" });
  });
export type ConversionConfig = z.input<typeof ConversionConfigSchema>;
export interface ConvertedProfile {
  format: "reqflow-procedural-profile-v1";
  model: VehicleModel;
  source: { url: string; author: string; license: string };
  report: {
    meshCount: number;
    vertexCount: number;
    detectedFeatures: string[];
    warnings: string[];
  };
}
export const ProceduralProfileSchema = z.object({
  format: z.literal("reqflow-procedural-profile-v1"),
  model: VehicleProfileSchema,
  source: z.object({ url: z.string(), author: z.string(), license: z.string() }),
  report: z.object({
    meshCount: z.number().int().positive(),
    vertexCount: z.number().int().positive(),
    detectedFeatures: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

const encodedBuffer = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const SourceMeshProfileSchema = ProceduralProfileSchema.extend({
  format: z.literal("reqflow-sketch-mesh-v1"),
  pieces: z
    .array(
      z.object({
        name: z.string(),
        partId: partIdSchema,
        kind: pieceKind,
        layer: z.enum(["exterior", "interior"]),
        positions: encodedBuffer,
        normals: encodedBuffer,
        indices: encodedBuffer,
      }),
    )
    .min(1),
});
export type SourceMeshProfile = z.infer<typeof SourceMeshProfileSchema>;
export const ConvertedProfileSchema = z.discriminatedUnion("format", [
  ProceduralProfileSchema,
  SourceMeshProfileSchema,
]);

/** Small catalog entries keep geometry out of the renderer's startup bundle. */
export const ConvertedProfileIndexSchema = z.object({
  format: z.literal("reqflow-model-index-v1"),
  file: z.string().regex(/^[a-z0-9][a-z0-9_.-]*\.json$/i),
  profileFormat: z.enum(["reqflow-procedural-profile-v1", "reqflow-sketch-mesh-v1"]),
  model: VehicleProfileSchema,
  source: z.object({ url: z.string(), author: z.string(), license: z.string() }),
  partIds: z.array(
    z.string().refine((value) => partIds.includes(value), "Unknown Reqflow part id"),
  ),
});
export type ConvertedProfileIndex = z.infer<typeof ConvertedProfileIndexSchema>;
export function createConvertedProfileIndex(
  profile: ConvertedProfile | SourceMeshProfile,
  file: string,
): ConvertedProfileIndex {
  return ConvertedProfileIndexSchema.parse({
    format: "reqflow-model-index-v1",
    file,
    profileFormat: profile.format,
    model: profile.model,
    source: profile.source,
    partIds:
      profile.format === "reqflow-sketch-mesh-v1"
        ? [
            ...new Set(
              profile.pieces.map((piece) => piece.partId).filter((id): id is string => id !== null),
            ),
          ].sort()
        : [],
  });
}

const featurePatterns: Partial<Record<CarSpecialPart, RegExp>> = {
  rear_spoiler: /spoiler/,
  duckbill_spoiler: /duckbill/,
  gt_wing: /gt.?wing|rear.?wing/,
  front_splitter: /splitter/,
  canards: /canard/,
  widebody_flares: /wide.?body|fender.?flare/,
  rear_diffuser: /diffuser/,
  roll_cage: /roll.?cage/,
  roof_rails: /roof.?rail/,
  skid_plates: /skid.?plate/,
  convertible_roof: /soft.?top|convertible.?roof/,
  hood_vents: /hood.?vent|bonnet.?vent|louver/,
};
function axisVector(value: string): THREE.Vector3 {
  const v = new THREE.Vector3();
  v.setComponent("xyz".indexOf(value.at(-1)!), value.startsWith("-") ? -1 : 1);
  return v;
}

/** Measure geometry, then rebuild using Reqflow's selectable procedural blueprint. */
export function convertScene(scene: THREE.Object3D, input: ConversionConfig): ConvertedProfile {
  const config = ConversionConfigSchema.parse(input);
  const up = axisVector(config.up);
  const forward = axisVector(config.forward);
  const right = new THREE.Vector3().crossVectors(forward, up);
  const orientation = new THREE.Matrix4().set(
    forward.x,
    forward.y,
    forward.z,
    0,
    up.x,
    up.y,
    up.z,
    0,
    right.x,
    right.y,
    right.z,
    0,
    0,
    0,
    0,
    1,
  );
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const namedBounds: { name: string; bounds: THREE.Box3 }[] = [];
  let vertexCount = 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object instanceof THREE.SkinnedMesh || object instanceof THREE.InstancedMesh)
      throw new Error("Skinned or instanced meshes must be exported as static meshes first");
    const names: string[] = [];
    for (let p: THREE.Object3D | null = object; p && p !== scene; p = p.parent) names.push(p.name);
    const name = names.join(" ").toLowerCase();
    if (config.excludeMeshes.some((text) => name.includes(text.toLowerCase()))) return;
    const positions = object.geometry.getAttribute("position");
    if (!positions || positions.count === 0) return;
    const box = new THREE.Box3();
    const transform = orientation.clone().multiply(object.matrixWorld);
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transform);
      if (![point.x, point.y, point.z].every(Number.isFinite))
        throw new Error(`Mesh '${object.name}' contains non-finite coordinates`);
      box.expandByPoint(point);
    }
    bounds.union(box);
    namedBounds.push({ name, bounds: box });
    vertexCount += positions.count;
  });
  const size = bounds.getSize(new THREE.Vector3());
  if (bounds.isEmpty() || Math.min(size.x, size.y, size.z) <= 0)
    throw new Error("Input must contain a non-flat 3D vehicle mesh");
  if (!config.unit && !config.dimensions.length)
    throw new Error(
      "Specify unit (m/cm/mm) or dimensions.length in metres; file scale is not guessed",
    );
  const scale = config.dimensions.length
    ? config.dimensions.length / size.x
    : { m: 1, cm: 0.01, mm: 0.001 }[config.unit!];
  const centre = bounds.getCenter(new THREE.Vector3());
  const length = size.x * scale;
  const width = config.dimensions.width ?? size.z * scale;
  const height = config.dimensions.height ?? size.y * scale;
  const warnings: string[] = [
    "Output is a procedural concept using the Reqflow base; source topology, textures and exact exterior contours are not retained.",
    "Body type and powertrain are supplied metadata, not inferred from geometry.",
  ];
  const detectedFeatures = Object.entries(featurePatterns)
    .filter(([, pattern]) => namedBounds.some(({ name }) => pattern!.test(name)))
    .map(([feature]) => feature as CarSpecialPart);
  if (!config.specialParts)
    warnings.push(
      "Features are inferred only from mesh names; review specialParts for missing or false matches.",
    );
  const wheels = namedBounds.filter(({ name }) =>
    /(?:^|[\s_.-])(wheel|tyre|tire)(?:$|[\s_.-]|\d)/.test(name),
  );
  // Union tyre/rim submeshes at the same wheel centre before measuring.
  const wheelGroups: THREE.Box3[] = [];
  for (const wheel of wheels) {
    const centre = wheel.bounds.getCenter(new THREE.Vector3());
    const existing = wheelGroups.find(
      (box) => box.getCenter(new THREE.Vector3()).distanceTo(centre) * scale < 0.15,
    );
    if (existing) existing.union(wheel.bounds);
    else wheelGroups.push(wheel.bounds.clone());
  }
  const wheelCentres = wheelGroups.map((box) => box.getCenter(new THREE.Vector3()));
  const validWheels =
    wheelCentres.length === 4 &&
    new THREE.Box3().setFromPoints(wheelCentres).getSize(new THREE.Vector3()).x * scale >
      length * 0.3;
  let frontAxleX = length * 0.3;
  let rearAxleX = -length * 0.3;
  let track = width * 0.84;
  let tyreRadius = height * 0.23;
  let tyreWidth = width * 0.13;
  if (validWheels) {
    const sorted = [...wheelCentres].sort((a, b) => a.x - b.x);
    rearAxleX = ((sorted[0]!.x + sorted[1]!.x) / 2 - centre.x) * scale;
    frontAxleX = ((sorted[2]!.x + sorted[3]!.x) / 2 - centre.x) * scale;
    track = (wheelCentres.reduce((sum, p) => sum + Math.abs(p.z - centre.z), 0) * scale) / 2;
    tyreRadius =
      (wheelGroups.reduce((sum, box) => sum + box.getSize(new THREE.Vector3()).y, 0) * scale) / 8;
    tyreWidth =
      (wheelGroups.reduce((sum, box) => sum + box.getSize(new THREE.Vector3()).z, 0) * scale) / 4;
  } else {
    warnings.push(
      "Could not identify four separate named wheels. Wheelbase, track and tyre dimensions use concept estimates unless overridden.",
    );
  }
  const d = config.dimensions;
  // An explicit wheelbase alone keeps the measured axle midpoint.
  if (d.wheelbase !== undefined && d.frontAxleX === undefined && d.rearAxleX === undefined) {
    const midpoint = (frontAxleX + rearAxleX) / 2;
    frontAxleX = midpoint + d.wheelbase / 2;
    rearAxleX = midpoint - d.wheelbase / 2;
  } else if (d.wheelbase !== undefined && d.frontAxleX !== undefined && d.rearAxleX === undefined) {
    rearAxleX = d.frontAxleX - d.wheelbase;
  } else if (d.wheelbase !== undefined && d.rearAxleX !== undefined && d.frontAxleX === undefined) {
    frontAxleX = d.rearAxleX + d.wheelbase;
  }
  frontAxleX = d.frontAxleX ?? frontAxleX;
  rearAxleX = d.rearAxleX ?? rearAxleX;
  const uid = config.sourceUrl?.match(/([a-f0-9]{32})(?:[/?#]|$)/)?.[1] ?? "";
  const model = VehicleProfileSchema.parse({
    id: config.id,
    name: config.name,
    sketchfabUid: uid,
    year: config.year,
    series: config.series,
    chassisCode: config.chassisCode,
    bodyType: config.bodyType,
    defaultPowertrain: config.powertrain,
    supportedPowertrains: config.supportedPowertrains ?? [config.powertrain],
    dimensions: {
      length,
      width,
      height,
      track,
      tyreRadius,
      tyreWidth,
      groundClearance: 0.14,
      ...d,
      frontAxleX,
      rearAxleX,
      wheelbase: d.wheelbase ?? frontAxleX - rearAxleX,
    },
    specialParts: config.specialParts ?? detectedFeatures,
    description: `Procedural concept derived from ${config.name}. Review the conversion report for measurement assumptions.`,
  });
  warnings.push(
    "The current Reqflow builder renders length, width, height and ground clearance; wheel measurements are retained as profile metadata.",
  );
  return {
    format: "reqflow-procedural-profile-v1",
    model,
    source: { url: config.sourceUrl ?? "", author: config.author, license: config.license },
    report: { meshCount: namedBounds.length, vertexCount, detectedFeatures, warnings },
  };
}

function pack(values: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (values instanceof Float32Array) view.setFloat32(i * 4, values[i]!, true);
    else view.setUint32(i * 4, values[i]!, true);
  }
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}

/** Decode little-endian packed buffers identically in the browser and the CLI tests. */
export function unpack(value: string, integer = false): Float32Array | Uint32Array {
  const text = atob(value);
  if (text.length % 4) throw new Error("Invalid packed geometry buffer length");
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const result = integer ? new Uint32Array(bytes.length / 4) : new Float32Array(bytes.length / 4);
  for (let i = 0; i < result.length; i++)
    result[i] = integer ? view.getUint32(i * 4, true) : view.getFloat32(i * 4, true);
  return result;
}

const nameMappings: [RegExp, string | null, z.infer<typeof pieceKind>, "exterior" | "interior"][] =
  [
    [/windshield|windscreen/, "windshield", "glass", "exterior"],
    [/rear.?window|back.?glass/, "rear_window", "glass", "exterior"],
    [/head.?light|head.?lamp/, "headlights", "lamp", "exterior"],
    [
      /tail.?light|back.?light|rear.?lamp|red.?glass|glass.?red|red.?glow/,
      "taillights",
      "tail",
      "exterior",
    ],
    [/light.?glass|glass.?light|white.?glow/, "headlights", "lamp", "exterior"],
    [/window|winsows|glass/, "side_windows", "glass", "exterior"],
    [/steering/, "steering_wheel", "trim", "interior"],
    [/tyre|tire/, "wheels", "tyre", "exterior"],
    [/wheel|rim/, "wheels", "rim", "exterior"],
    [/mirror/, "mirrors", "paint", "exterior"],
    [/hood|bonnet/, "hood", "paint", "exterior"],
    [/spoiler|wing/, "rear_spoiler", "dark", "exterior"],
    [/splitter|canard/, "front_splitter", "dark", "exterior"],
    [/diffuser/, "rear_diffuser", "dark", "exterior"],
    [/roof.?rail/, "roof_rails", "metal", "exterior"],
    [/roof/, "roof", "paint", "exterior"],
    [/grille|grill/, "kidney_grille", "dark", "exterior"],
    [/rear.?door|door[_ .-]?b[lr](?:[_ .-]|\d)/, "rear_doors", "paint", "exterior"],
    [/door/, "front_doors", "paint", "exterior"],
    [/trunk|boot.?lid/, "trunk_lid", "paint", "exterior"],
    [/rear.?bumper|bumper[_ .-]?(?:back|b_|r\d)/, "rear_bumper", "paint", "exterior"],
    [/front.?bumper|bumper[_ .-]?(?:front|f_|f\d)/, "front_bumper", "paint", "exterior"],
    [/steering/, "steering_wheel", "trim", "interior"],
    [/rear.?seat/, "rear_seats", "seat", "interior"],
    [/seat/, "front_seats", "seat", "interior"],
    [/dashboard|dash.?board/, "dashboard", "trim", "interior"],
    [/console/, "center_console", "trim", "interior"],
    [/exhaust/, "exhaust_system", "metal", "exterior"],
    // A single cabin shell is kept visible inside, without claiming separate selectable seats/dash.
    [/interior|internal|salon/, null, "trim", "interior"],
  ];

/** Retain every source triangle; only rigid axis conversion, translation and uniform unit scaling. */
export function convertSketchScene(
  scene: THREE.Object3D,
  input: ConversionConfig,
): SourceMeshProfile {
  const config = ConversionConfigSchema.parse(input);
  const profile = convertScene(scene, input);
  const up = axisVector(config.up);
  const forward = axisVector(config.forward);
  const right = new THREE.Vector3().crossVectors(forward, up);
  const orientation = new THREE.Matrix4().makeBasis(forward, up, right).transpose();
  const meshes: { mesh: THREE.Mesh; transform: THREE.Matrix4; name: string }[] = [];
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const names: string[] = [];
    for (let p: THREE.Object3D | null = object; p && p !== scene; p = p.parent) names.push(p.name);
    const name = names.join(" ");
    if (config.excludeMeshes.some((text) => name.toLowerCase().includes(text.toLowerCase())))
      return;
    if (
      Object.values(object.geometry.morphAttributes).some(
        (attributes) => Array.isArray(attributes) && attributes.length > 0,
      )
    )
      throw new Error("Morph targets must be exported as a static mesh before preserving shape");
    const positions = object.geometry.getAttribute("position");
    if (!positions || positions.count === 0) return;
    const transform = orientation.clone().multiply(object.matrixWorld);
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++)
      bounds.expandByPoint(point.fromBufferAttribute(positions, i).applyMatrix4(transform));
    meshes.push({ mesh: object, transform, name });
  });
  const size = bounds.getSize(new THREE.Vector3());
  const scale = profile.model.dimensions.length / size.x;
  if (
    (config.dimensions.width !== undefined &&
      Math.abs(config.dimensions.width - size.z * scale) > 0.0005) ||
    (config.dimensions.height !== undefined &&
      Math.abs(config.dimensions.height - size.y * scale) > 0.0005)
  )
    throw new Error(
      "Preserving source shape requires uniform scaling. Remove width/height overrides, or use --mode procedural.",
    );
  const center = bounds.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);
  const pieces: SourceMeshProfile["pieces"] = [];
  const unknown = new Set<string>();
  for (const { mesh, transform, name } of meshes) {
    const geometry = mesh.geometry.clone();
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const positions = new Float32Array(position.count * 3);
    const normals = new Float32Array(position.count * 3);
    const vector = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
    for (let i = 0; i < position.count; i++) {
      vector
        .fromBufferAttribute(position, i)
        .applyMatrix4(transform)
        .add(offset)
        .multiplyScalar(scale);
      vector.toArray(positions, i * 3);
      vector
        .fromBufferAttribute(normal, i)
        .applyNormalMatrix(normalMatrix)
        .toArray(normals, i * 3);
      if (![vector.x, vector.y, vector.z].every(Number.isFinite))
        throw new Error(`Mesh '${name}' contains non-finite normals`);
    }
    const count = geometry.index?.count ?? position.count;
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count, materialIndex: 0 }];
    for (const group of groups) {
      const start = Math.max(group.start, geometry.drawRange.start);
      const end = Math.min(
        group.start + group.count,
        count,
        geometry.drawRange.start + geometry.drawRange.count,
      );
      if (start >= end) continue;
      if ((end - start) % 3) throw new Error(`Mesh '${name}' is not a triangle mesh`);
      const material = Array.isArray(mesh.material)
        ? mesh.material[group.materialIndex ?? 0]
        : mesh.material;
      const hints = [
        name,
        material?.name,
        mesh.userData.sourceMaterial,
        geometry.userData.sourceMaterial,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const override = config.mappings.find((mapping) =>
        hints.includes(mapping.match.toLowerCase()),
      );
      const automatic = nameMappings.find(([pattern]) => pattern.test(hints));
      const partId = override ? override.partId : automatic ? automatic[1] : "body";
      const kind = override?.kind ?? automatic?.[2] ?? "paint";
      const layer = override?.layer ?? automatic?.[3] ?? "exterior";
      if (!override && !automatic) unknown.add(name || "(unnamed mesh)");
      const indices = new Uint32Array(end - start);
      for (let i = start; i < end; i++) indices[i - start] = geometry.index?.getX(i) ?? i;
      if (!indices.every((index) => index < position.count))
        throw new Error(`Mesh '${name}' contains an invalid triangle index`);
      // Bake mirrored node transforms while keeping outward triangle winding.
      if (transform.determinant() < 0)
        for (let i = 0; i < indices.length; i += 3)
          [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
      // Keep material pieces compact and their bounds local to the referenced triangles.
      const remap = new Map<number, number>();
      const compactPositions: number[] = [];
      const compactNormals: number[] = [];
      for (let i = 0; i < indices.length; i++) {
        const original = indices[i]!;
        let mapped = remap.get(original);
        if (mapped === undefined) {
          mapped = remap.size;
          remap.set(original, mapped);
          for (let axis = 0; axis < 3; axis++) {
            compactPositions.push(positions[original * 3 + axis]!);
            compactNormals.push(normals[original * 3 + axis]!);
          }
        }
        indices[i] = mapped;
      }
      pieces.push({
        name: name || mesh.name,
        partId,
        kind,
        layer,
        positions: pack(new Float32Array(compactPositions)),
        normals: pack(new Float32Array(compactNormals)),
        indices: pack(indices),
      });
    }
    geometry.dispose();
  }
  const warnings = profile.report.warnings.filter(
    (warning) =>
      !warning.startsWith("Output is a procedural") &&
      !warning.startsWith("The current Reqflow builder"),
  );
  warnings.push(
    "Source triangles and normals are retained at Float32 precision. Axes, origin and units are normalized with uniform scaling; no decimation or remeshing.",
  );
  warnings.push(
    "Materials/textures are replaced by Reqflow sketch styling. Powertrain switching does not replace the source's drivetrain geometry; only source parts are available.",
  );
  if (unknown.size)
    warnings.push(
      `${unknown.size} unrecognized mesh name(s) mapped to body/paint/exterior: ${[...unknown].slice(0, 12).join(", ")}. Add mappings for separate selectable parts.`,
    );
  return {
    ...profile,
    format: "reqflow-sketch-mesh-v1",
    pieces,
    report: { ...profile.report, warnings },
  };
}

/** Converted entries may intentionally replace a catalog ID; duplicates among files are errors. */
export function mergeConvertedProfiles(
  base: VehicleModel[],
  files: Record<string, unknown>,
): VehicleModel[] {
  const models = new Map(base.map((model) => [model.id, model]));
  const seen = new Set<string>();
  for (const [path, file] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const result = ConvertedProfileSchema.safeParse(file);
    if (!result.success)
      throw new Error(`Invalid converted car profile ${path}: ${result.error.message}`);
    const model = result.data.model;
    if (seen.has(model.id)) throw new Error(`Duplicate converted car id '${model.id}' in ${path}`);
    seen.add(model.id);
    models.set(model.id, model);
  }
  return [...models.values()];
}
