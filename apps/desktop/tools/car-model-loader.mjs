import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

/** Local geometry only: no texture downloads or network dependencies. */
export async function loadCarModel(path) {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  if (extension === ".obj") return new OBJLoader().parse(bytes.toString("utf8"));
  if (extension === ".stl") {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new STLLoader().parse(data)));
    return scene;
  }
  if (![".glb", ".gltf"].includes(extension))
    throw new Error(
      "Supported files: .glb, .gltf, .obj, .stl. Export FBX/Blend as uncompressed glTF or OBJ first.",
    );
  let json;
  let bin;
  if (extension === ".glb") {
    if (
      bytes.length < 20 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length
    )
      throw new Error("Invalid glTF 2.0 GLB header or length");
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new Error("Truncated GLB chunk header");
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end > bytes.length) throw new Error("Truncated GLB chunk");
      const chunk = bytes.subarray(offset + 8, end);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
      if (type === 0x004e4942) bin = chunk;
      offset = end;
    }
    if (!json) throw new Error("GLB has no JSON chunk");
  } else json = JSON.parse(bytes.toString("utf8"));

  if (json.asset?.version !== "2.0") throw new Error("Only glTF 2.0 is supported");
  const compression = /draco|meshopt/i;
  if (
    [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])].some((name) =>
      compression.test(name),
    )
  )
    throw new Error(
      "Compressed Draco/Meshopt geometry is unsupported. Export uncompressed glTF/GLB or OBJ first.",
    );
  const folder = resolve(dirname(path));
  for (const buffer of json.buffers ?? []) {
    let data;
    if (!buffer.uri) {
      if (!bin) throw new Error("Missing GLB binary buffer");
      data = bin;
    } else if (buffer.uri.startsWith("data:")) {
      if (!/^data:[^,]*;base64,/.test(buffer.uri))
        throw new Error("Only base64 data buffers are supported");
      data = Buffer.from(buffer.uri.slice(buffer.uri.indexOf(",") + 1), "base64");
    } else {
      if (/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(buffer.uri))
        throw new Error(
          "glTF buffers must be local relative files; remote and absolute URIs are unsupported",
        );
      const file = resolve(folder, decodeURIComponent(buffer.uri));
      if (!file.startsWith(folder + sep))
        throw new Error("glTF buffer must stay within the model directory");
      data = await readFile(file);
    }
    if (data.length < buffer.byteLength) throw new Error("Truncated glTF binary buffer");
    buffer.uri = `data:application/octet-stream;base64,${data.toString("base64")}`;
  }
  // Preserve material names as mapping hints, without instantiating image loaders.
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      const material = json.materials?.[primitive.material];
      primitive.extras = { ...primitive.extras, sourceMaterial: material?.name ?? "" };
      delete primitive.material;
    }
  delete json.materials;
  delete json.textures;
  delete json.images;
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(
    (name) => !/material|texture/i.test(name),
  );
  // FileLoader dispatches ProgressEvent even for data URLs, which older Node lacks.
  if (!globalThis.ProgressEvent) {
    globalThis.ProgressEvent = class ProgressEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        Object.assign(this, init);
      }
    };
  }
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), "");
  return gltf.scene;
}
