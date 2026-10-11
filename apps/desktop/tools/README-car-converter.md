# Convert a downloaded car to Reqflow's sketch style

This offline program converts a GLB/glTF, OBJ or STL into Reqflow's sketch style
while preserving the source car's exterior geometry, proportions and features.
It retains source triangles and normals at Float32 precision, aligns the axes,
centres the car and uniformly converts its scale into metres. It applies Reqflow's
light/dark sketch materials, part selection and requirement badges through the
same viewer as the base car. There is no decimation, remeshing or shape replacement.
No Blender or new npm dependencies are needed. Use Node 22.13+ and the repository's
installed dependencies.

Materials and texture assets are replaced by the sketch look. Texture-only detail
is not converted into geometry. Interiors and drivetrain geometry come from the
source; powertrain choices do not generate replacements for this imported mesh.
Named meshes/materials map to selectable parts. A combined body stays combined:
explicit mappings or an export with separate panels are needed for panel selection.

1. Download a model using Sketchfab's download button and unpack its archive.
   Keep glTF's `.bin` files beside the `.gltf` in their original relative folders.
   Use files you have permission to modify; preserve the model page's attribution
   and license in the config. The converter does not download models or log in.
2. Copy `apps/desktop/tools/car-config.example.json` to a config outside the source
   directory, then edit the model identity, body class, powertrain and dimensions.
3. From the Reqflow repository root, inspect the model if necessary:

   ```sh
   node --experimental-strip-types apps/desktop/tools/convert-car.mjs \
     --input /absolute/path/scene.gltf --inspect
   ```

4. Convert into the catalog's imported directory:

   ```sh
   node --experimental-strip-types apps/desktop/tools/convert-car.mjs \
     --input /absolute/path/scene.gltf \
     --config /absolute/path/car-config.json \
     --output apps/desktop/src/renderer/src/components/car/models/imported/my-car.json
   ```

5. Start/restart `npm run dev` (or rebuild the app), choose the configured name in
   **Settings → Model Switcher**, then view it on the Car tab. JSON profiles in `models/imported/` are bundled
   at build time. This is a developer conversion tool, not a runtime file-upload UI.
   The CLI writes a small metadata index in `models/imported/meta/`; keep it beside
   the geometry profile. The catalog reads the index immediately and loads geometry
   only when selected, keeping large source meshes out of the startup bundle.
   A profile with an existing catalog ID replaces that definition; two imported
   files with the same ID produce a clear error. Remove the profile JSON and its
   corresponding `meta/` JSON, then restart to undo.
   The CLI refuses to overwrite an existing output unless passed `--force`.
   The existing shared desktop smoke script assumes exactly 105 catalog entries;
   use existing catalog IDs for replacements to keep that count. Unit tests also support additional entries.

## Configuration

All dimensions are **metres**. `forward` and `up` describe the source coordinate
system: `x`, `y`, `z`, `-x`, `-y` or `-z`. They must use different axes. Standard
glTF exports commonly use `up: "y"` and `forward: "-z"`; inspect your actual export.
An OBJ/STL can use any axes and has no reliable unit metadata.

Supply `unit` (`m`, `cm`, `mm`) or a known `dimensions.length`. Length calibrates
the whole source mesh with **uniform scaling**. Width/height overrides that would
distort the original shape are rejected in the default sketch mode. Scale is never
guessed. `excludeMeshes` contains case-insensitive substrings matched against mesh
and ancestor names; use it to exclude a floor, backdrop, stand or detached accessory.
Bounds include every remaining mesh, including mirrors and spoilers. They are
concept measurements, not certified production dimensions.

Required fields: `id`, `name`, `year`, `series`, `chassisCode`, `bodyType`.
Optional: `sourceUrl` (full model page URL, not the collection URL), `author`,
`license`, `powertrain` (defaults to gasoline), `supportedPowertrains`, `unit`,
`up`, `forward`, `dimensions`, `specialParts`, `excludeMeshes`, `mappings`.
Unknown config fields are rejected to catch typos.

`bodyType`: `sedan`, `coupe`, `touring`, `suv`, `convertible`, `gran_coupe`,
`race`, `concept`, `roadster`, `hatchback`. These are user-supplied: an arbitrary
triangle mesh cannot reliably identify its body class or powertrain.

`specialParts` describes equipment in the catalog metadata. In sketch mode the
source mesh supplies the actual geometry; this list does not add/remove features.
Omit it to detect supported aero/trim names, or use `[]` to disable detection.
Supported values:
`rear_spoiler`, `duckbill_spoiler`, `gt_wing`, `front_splitter`, `canards`,
`widebody_flares`, `rear_diffuser`, `roll_cage`, `roof_rails`, `skid_plates`,
`convertible_roof`, `hood_vents`, `exhaust_system`, `fuel_system`, `h2_storage`,
`combustion_engine`, `fuel_cell`.

`mappings` overrides automatic name-based classification. Each entry matches a
case-insensitive substring in mesh/ancestor/material names. The first matching
entry wins. Use a Reqflow part ID from `converter/partIds.json`, a piece kind from
`model/buildCar.ts`, and `exterior` or `interior`:

```json
{
  "mappings": [
    { "match": "front_glass", "partId": "windshield", "kind": "glass", "layer": "exterior" },
    { "match": "driver_seat", "partId": "driver_seat", "kind": "seat", "layer": "interior" },
    { "match": "body_shell", "partId": "body", "kind": "paint", "layer": "exterior" }
  ]
}
```

Exported lamp names take precedence over generic glass names; steering wheels are
kept separate from road wheels. A mesh named as a whole interior/cabin is retained
on the interior layer with no selectable part ID. It does not imply separate
seats or dashboard geometry. Explicit mappings still take precedence.

Use `partId: null` for a non-selectable surface. Unknown names fall back to
`body`/`paint`/`exterior` and are listed in the report; incorrect part IDs fail
validation. `--inspect` prints mesh names, material hints and bounds for mapping.

Four individually named wheel/tyre/tire assemblies yield measured axle positions,
wheelbase, track and tyre sizes. Without them these are explicitly reported concept
estimates, and `dimensions` can override them. These are catalog metadata in sketch
mode: actual wheels stay exactly where the source placed them. A wheelbase metadata
override preserves the measured axle midpoint unless an axle is also supplied.

The output includes geometry encoded in little-endian packed buffers, provenance
and a conversion report. Source material names are kept as mapping hints; images
are ignored. Draco/Meshopt compression, animated/skinned/morphed or instanced
geometry, FBX and Blend need a static, uncompressed glTF/OBJ export first. Remote
glTF buffer URLs are rejected.

Optional `--mode procedural` emits the earlier blueprint profile: it rebuilds the
car from Reqflow's base with measured length/width/height/stance, supplied body class,
powertrain and special equipment. This mode allows independent width/height overrides
and does not retain the source silhouette. Its wheel measurements remain metadata.

## Replace all models except the basic M5

The bulk command covers all 104 other catalog IDs. First prepare a manifest:

```sh
node --experimental-strip-types apps/desktop/tools/convert-car-catalog.mjs \
  --plan apps/desktop/out/catalog-conversion-plan.json \
  --sources /absolute/path/to/unpacked-models
```

`--sources` is optional. A filename or parent folder containing the catalog ID or
Sketchfab UID matches automatically when there is exactly one supported file.
Missing or ambiguous matches have `input: null`. Fill those paths (relative to the
manifest or absolute), check each source's axes and length calibration, and record
its author and license. Plans use the catalog length for uniform scaling; source
width, height, wheels and details remain unchanged in proportion. Adjust exclusions
and part mappings for the actual export as described above. Archives must be unpacked.

When every model has its source file, apply the manifest:

```sh
node --experimental-strip-types apps/desktop/tools/convert-car-catalog.mjs \
  --apply apps/desktop/out/catalog-conversion-plan.json
```

This stages the complete set before installing it into `models/imported/`.
Missing sources or conversion errors leave the current catalog untouched. The
command excludes the basic M5 (`bmw_m5_sedan_g90_2025`), preserves custom profiles,
removes superseded imported files for the 104 IDs, and installs one source profile
per ID. Registry merging replaces each old procedural catalog entry without adding
a duplicate; the viewer uses its source mesh. Rebuild/restart the app afterward.
The shared basic geometry and legacy builder code remain available until source
coverage is complete; this command does not delete shared source code or originals.
Keep the manifest and source files outside the imported output folder. Close builds
and dev watchers while applying a completed manifest.

If Sketchfab's daily download limit prevents obtaining the complete set, add
`--partial` to `--apply`. Only entries with source files are staged and installed;
models still waiting for downloads remain available in their existing form. The
command reports the remaining count and keeps the same IDs without duplicate
catalog entries. A later application replaces additional IDs as sources arrive.

## Verification

```sh
npm test -- apps/desktop/src/renderer/src/components/car/converter --maxWorkers=1 --testTimeout=20000
npm run typecheck
```

Tests generate synthetic cars and exercise actual file parsing, scene transforms,
units/axes, wheel and feature detection, validation and catalog integration. Shape
tests compare every drawn source triangle after coordinate normalization, and verify
material-group selection, local badge anchors and reversible view transitions.

To compare installed geometry against the downloaded files:

```sh
node --experimental-strip-types apps/desktop/tools/verify-car-catalog.mjs \
  --manifest apps/desktop/out/catalog-conversion-plan.json \
  --report apps/desktop/out/source-shape-verification.json
```

The verifier checks every drawn triangle vertex after world transforms, axis
projection, origin normalization and uniform scale, including reflected node
winding and material groups. Added, missing or changed triangles fail verification
(tolerance: 1 micrometre). It reports the largest coordinate error for each car.
