import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  buildCar,
  type CarModel,
  type CarPiece,
  type PieceKind,
  type PieceLayer,
} from "../model/buildCar";
import { G60 } from "../model/body";
import type { PowertrainType, VehicleModel } from "./types";
import {
  isTwoDoor,
  isTwoSeater,
  isSingleSeaterRaceCar,
  isConvertible,
  isSuv,
  isTouring,
  isWidebody,
  modelExcludedPartIds,
} from "./features";

/**
 * Builds a 3D car model based on the baseline blueprint (`buildCar`), customized
 * for the selected vehicle model's dimensions, body style, powertrain architecture,
 * and car-specific aerodynamic/chassis components (spoilers, splitters, diffusers,
 * roll cages, roof rails, etc.).
 *
 * It removes non-existent components (e.g. rear doors on 2-door coupes, rear seats on
 * roadsters/race cars, luxury items on stripped race cockpits) and adds distinct
 * class-defining geometry so each BMW class (Sedan, Coupé, SUV/SAV, Touring/Wagon,
 * Roadster/Convertible, and pure Motorsport/Race) is immediately recognizable.
 */
export function buildVehicleModel(
  model?: VehicleModel,
  powertrain: PowertrainType = "electric",
): CarModel {
  const base = buildCar(powertrain);
  if (!model) return base;

  const root = base.root;
  root.name = `${model.name} (${model.chassisCode}) — ${powertrain}`;
  const pieces = base.pieces;
  const anchors = base.anchors;

  // 1. Remove non-existent features from the baseline blueprint
  const excluded = modelExcludedPartIds(model);
  if (excluded.size > 0) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i]!;
      if (piece.partId && excluded.has(piece.partId)) {
        root.remove(piece.mesh);
        piece.mesh.geometry.dispose();
        if (Array.isArray(piece.mesh.material)) {
          piece.mesh.material.forEach((m) => m.dispose());
        } else if (piece.mesh.material) {
          piece.mesh.material.dispose();
        }
        pieces.splice(i, 1);
      }
    }
    for (const id of excluded) {
      anchors.delete(id);
    }
  }

  const add = (
    geometry: THREE.BufferGeometry,
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    place?: (m: THREE.Mesh) => void,
  ) => {
    const mesh = new THREE.Mesh(geometry);
    mesh.name = partId ?? kind;
    place?.(mesh);
    mesh.userData.partId = partId;
    root.add(mesh);
    const piece: CarPiece = { mesh, partId, kind, layer };
    pieces.push(piece);
    return mesh;
  };

  const box = (
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    size: [number, number, number],
    pos: [number, number, number],
    opts: { radius?: number; rotZ?: number; rotY?: number; rotX?: number } = {},
  ) => {
    const r = Math.min(opts.radius ?? 0.03, Math.min(...size) / 2 - 0.0005);
    return add(
      new RoundedBoxGeometry(size[0], size[1], size[2], 3, r),
      partId,
      kind,
      layer,
      (m) => {
        m.position.set(...pos);
        m.rotation.set(opts.rotX ?? 0, opts.rotY ?? 0, opts.rotZ ?? 0);
      },
    );
  };

  const frontAxleX = G60.frontAxleX;
  const rearAxleX = G60.rearAxleX;
  const frontX = G60.frontX;
  const rearX = G60.rearX;
  const halfTrack = G60.track / 2;
  const tyreRadius = G60.tyreRadius;
  const specialParts = model.specialParts;
  const deckY = 1.14;

  // ---- 2. Recognizable Class-Specific Geometry -------------------------------------------

  // A. Coupé (2-door): Seamless rear quarter flanks, low roof ridge, and elongated frameless sills
  if (isTwoDoor(model)) {
    for (const side of [-1, 1]) {
      // Sculpted continuous rear quarter flank replacing rear door aperture
      box("body", "paint", "exterior", [1.14, 0.44, 0.05], [-0.74, 0.62, side * 0.94], {
        radius: 0.035,
      });
      // Elongated coupe sill extension
      box("body", "dark", "exterior", [1.68, 0.08, 0.04], [-0.15, 0.28, side * 0.94], {
        radius: 0.015,
      });
      // Sleek Hofmeister kink quarter window styling
      box("side_windows", "dark", "exterior", [0.46, 0.22, 0.02], [-0.88, 1.08, side * 0.74], {
        radius: 0.015,
        rotZ: -0.22,
      });
    }
    // M double-bubble carbon roof ridge contour along centerline
    box("roof", "dark", "exterior", [1.42, 0.025, 0.52], [-0.46, 1.49, 0], {
      radius: 0.01,
    });
  }

  // B. 2-Seaters (Roadsters, M1, track specials): Rear bulkhead & luggage shelf
  if (isTwoSeater(model)) {
    box("luggage", "trim", "interior", [0.54, 0.12, 1.24], [-0.98, 0.68, 0], { radius: 0.025 });
  }

  // C. Single-Seater Race Cars: Stripped lightweight cockpit with racing switchboard and fire extinguisher
  if (isSingleSeaterRaceCar(model)) {
    box("center_console", "metal", "interior", [0.38, 0.16, 0.18], [0.12, 0.62, 0], {
      radius: 0.02,
    });
    box("center_console", "accent", "interior", [0.12, 0.28, 0.12], [-0.32, 0.48, 0.38], {
      radius: 0.04,
      rotZ: 1.57,
    });
  }

  // D. SUV / SAV / SAC: Rugged protective wheel arch & rocker cladding, SAV tailgate roof spoiler
  if (isSuv(model)) {
    for (const side of [-1, 1]) {
      // Rugged dark wheel arch cladding
      box(
        "body",
        "dark",
        "exterior",
        [0.84, 0.22, 0.045],
        [frontAxleX, tyreRadius + 0.12, side * (halfTrack + 0.035)],
        { radius: 0.03 },
      );
      box(
        "body",
        "dark",
        "exterior",
        [0.86, 0.24, 0.045],
        [rearAxleX, tyreRadius + 0.13, side * (halfTrack + 0.04)],
        { radius: 0.035 },
      );
      // Heavy-duty lower rocker sill protective armor
      box(
        "body",
        "dark",
        "exterior",
        [frontAxleX - rearAxleX - 0.72, 0.09, 0.04],
        [(frontAxleX + rearAxleX) / 2, 0.26, side * (halfTrack + 0.03)],
        { radius: 0.02 },
      );
    }
    // Upright SAV tailgate roof spoiler (for non-coupe SUVs like X1, X3, X5, X7)
    if (
      !model.series.includes("X4") &&
      !model.series.includes("X6") &&
      !model.name.includes("X4") &&
      !model.name.includes("X6")
    ) {
      box("body", "paint", "exterior", [0.28, 0.065, 1.24], [rearX + 0.18, 1.48, 0], {
        radius: 0.02,
      });
      box("rear_window", "dark", "exterior", [0.12, 0.48, 1.14], [rearX + 0.22, 1.18, 0], {
        radius: 0.025,
        rotZ: 0.18,
      });
    }
  }

  // E. Touring / Wagon / Estate: Extended continuous estate roofline & D-pillar cargo glass
  if (isTouring(model)) {
    // Extended estate roofline covering cargo compartment
    box("roof", "paint", "exterior", [1.1, 0.06, 1.28], [-1.22, 1.47, 0], { radius: 0.03 });
    // D-pillar upright estate cargo glazing
    for (const side of [-1, 1]) {
      box("side_windows", "dark", "exterior", [0.72, 0.26, 0.02], [-1.22, 1.14, side * 0.72], {
        radius: 0.015,
      });
    }
    // Tailgate roof edge spoiler
    box("body", "dark", "exterior", [0.26, 0.045, 1.22], [rearX + 0.22, 1.46, 0], {
      radius: 0.015,
    });
    // Luggage cargo bay floor
    box("luggage", "trim", "interior", [0.94, 0.06, 1.16], [-1.28, 0.48, 0], { radius: 0.02 });
  }

  // F. Convertible / Roadster: Rollover hoops and tonneau cover
  if (isConvertible(model)) {
    for (const side of [-1, 1]) {
      box("body", "metal", "interior", [0.06, 0.22, 0.24], [-0.64, 1.08, side * 0.38], {
        radius: 0.03,
      });
    }
    box("body", "paint", "exterior", [0.58, 0.05, 1.32], [-0.98, 0.94, 0], { radius: 0.02 });
  }

  // ---- 3. Special Equipment & Aerodynamic Components -------------------------------------

  // 1. GT Wing / Motorsport Wing
  if (specialParts.includes("gt_wing")) {
    box(
      "rear_spoiler",
      "dark",
      "exterior",
      [0.07, 0.28, 0.035],
      [rearX + 0.28, deckY + 0.14, -0.46],
      {
        radius: 0.008,
        rotZ: -0.15,
      },
    );
    box(
      "rear_spoiler",
      "dark",
      "exterior",
      [0.07, 0.28, 0.035],
      [rearX + 0.28, deckY + 0.14, 0.46],
      {
        radius: 0.008,
        rotZ: -0.15,
      },
    );
    box("rear_spoiler", "dark", "exterior", [0.32, 0.035, 1.48], [rearX + 0.24, deckY + 0.28, 0], {
      radius: 0.012,
      rotZ: 0.08,
    });
    box(
      "rear_spoiler",
      "dark",
      "exterior",
      [0.34, 0.16, 0.018],
      [rearX + 0.24, deckY + 0.28, -0.74],
      {
        radius: 0.006,
      },
    );
    box(
      "rear_spoiler",
      "dark",
      "exterior",
      [0.34, 0.16, 0.018],
      [rearX + 0.24, deckY + 0.28, 0.74],
      {
        radius: 0.006,
      },
    );
    anchors.set("rear_spoiler", new THREE.Vector3(rearX + 0.24, deckY + 0.28, 0));
  } else if (specialParts.includes("duckbill_spoiler") || specialParts.includes("rear_spoiler")) {
    box("rear_spoiler", "dark", "exterior", [0.14, 0.065, 1.18], [rearX + 0.08, deckY + 0.035, 0], {
      radius: 0.015,
      rotZ: 0.4,
    });
    anchors.set("rear_spoiler", new THREE.Vector3(rearX + 0.08, deckY + 0.06, 0));
  }

  // 2. Front Splitter & Canards
  if (specialParts.includes("front_splitter")) {
    box("front_splitter", "dark", "exterior", [0.24, 0.026, 1.76], [frontX + 0.09, 0.21, 0], {
      radius: 0.01,
    });
    box("front_splitter", "metal", "exterior", [0.012, 0.13, 0.012], [frontX + 0.11, 0.28, -0.34], {
      rotZ: 0.38,
    });
    box("front_splitter", "metal", "exterior", [0.012, 0.13, 0.012], [frontX + 0.11, 0.28, 0.34], {
      rotZ: 0.38,
    });
    anchors.set("front_splitter", new THREE.Vector3(frontX + 0.12, 0.22, 0));
  }

  if (specialParts.includes("canards")) {
    for (const [y, rot] of [
      [0.44, 0.28],
      [0.54, 0.34],
    ] as const) {
      box("front_splitter", "dark", "exterior", [0.14, 0.016, 0.2], [frontX - 0.14, y, -0.89], {
        rotZ: rot,
        rotY: 0.35,
      });
      box("front_splitter", "dark", "exterior", [0.14, 0.016, 0.2], [frontX - 0.14, y, 0.89], {
        rotZ: rot,
        rotY: -0.35,
      });
    }
  }

  // 3. Rear Diffuser
  if (specialParts.includes("rear_diffuser")) {
    box("rear_diffuser", "dark", "exterior", [0.42, 0.07, 1.32], [rearX + 0.24, 0.27, 0], {
      radius: 0.02,
      rotZ: -0.24,
    });
    for (const z of [-0.48, -0.16, 0.16, 0.48]) {
      box("rear_diffuser", "dark", "exterior", [0.36, 0.075, 0.018], [rearX + 0.24, 0.25, z], {
        rotZ: -0.24,
      });
    }
    anchors.set("rear_diffuser", new THREE.Vector3(rearX + 0.15, 0.25, 0));
  }

  // 4. Widebody Kit & Arch Flares
  if (specialParts.includes("widebody_flares") || isWidebody(model)) {
    for (const side of [-1, 1]) {
      box(
        "widebody_flares",
        "paint",
        "exterior",
        [0.78, 0.26, 0.075],
        [frontAxleX, tyreRadius + 0.17, side * (halfTrack + 0.055)],
        { radius: 0.035 },
      );
      box(
        "widebody_flares",
        "paint",
        "exterior",
        [0.82, 0.28, 0.085],
        [rearAxleX, tyreRadius + 0.18, side * (halfTrack + 0.06)],
        { radius: 0.04 },
      );
      box(
        "widebody_flares",
        "dark",
        "exterior",
        [frontAxleX - rearAxleX - 0.7, 0.05, 0.06],
        [(frontAxleX + rearAxleX) / 2, 0.23, side * (halfTrack + 0.05)],
        { radius: 0.015 },
      );
    }
    anchors.set(
      "widebody_flares",
      new THREE.Vector3(frontAxleX, tyreRadius + 0.2, halfTrack + 0.06),
    );
  }

  // 5. Motorsport Safety Roll Cage
  if (specialParts.includes("roll_cage")) {
    const cageZ = 0.52;
    box("roll_cage", "accent", "interior", [0.045, 0.82, 0.045], [-0.46, 0.95, -cageZ], {
      radius: 0.02,
    });
    box("roll_cage", "accent", "interior", [0.045, 0.82, 0.045], [-0.46, 0.95, cageZ], {
      radius: 0.02,
    });
    box("roll_cage", "accent", "interior", [0.045, 0.045, cageZ * 2], [-0.46, 1.34, 0], {
      radius: 0.02,
    });
    box("roll_cage", "accent", "interior", [0.85, 0.042, 0.042], [-0.92, 0.96, -cageZ * 0.45], {
      radius: 0.018,
      rotZ: -0.52,
    });
    box("roll_cage", "accent", "interior", [0.85, 0.042, 0.042], [-0.92, 0.96, cageZ * 0.45], {
      radius: 0.018,
      rotZ: -0.52,
    });
    anchors.set("roll_cage", new THREE.Vector3(-0.46, 1.15, 0));
  }

  // 6. Roof Rails (Touring & SUV/SAV models)
  if (specialParts.includes("roof_rails")) {
    for (const side of [-1, 1]) {
      box("roof_rails", "metal", "exterior", [1.9, 0.038, 0.032], [-0.52, 1.52, side * 0.58], {
        radius: 0.012,
      });
      for (const x of [0.35, -0.52, -1.38]) {
        box("roof_rails", "dark", "exterior", [0.08, 0.035, 0.04], [x, 1.5, side * 0.58], {
          radius: 0.01,
        });
      }
    }
    anchors.set("roof_rails", new THREE.Vector3(-0.52, 1.54, 0.58));
  }

  // 7. Skid Plates (SAV / SUV models)
  if (specialParts.includes("skid_plates")) {
    box("skid_plates", "metal", "exterior", [0.32, 0.04, 0.88], [frontX - 0.04, 0.23, 0], {
      radius: 0.016,
    });
    box("skid_plates", "metal", "exterior", [0.32, 0.04, 0.88], [rearX + 0.12, 0.25, 0], {
      radius: 0.016,
    });
    anchors.set("skid_plates", new THREE.Vector3(frontX - 0.04, 0.23, 0));
  }

  // 8. Convertible Soft-Top
  if (specialParts.includes("convertible_roof")) {
    box("convertible_roof", "dark", "exterior", [1.72, 0.28, 1.28], [-0.46, 1.36, 0], {
      radius: 0.12,
    });
    anchors.set("convertible_roof", new THREE.Vector3(-0.46, 1.48, 0));
  }

  // 9. Bonnet Cooling Louvers / Hood Vents
  if (specialParts.includes("hood_vents")) {
    for (const side of [-1, 1]) {
      box("hood_vents", "dark", "exterior", [0.32, 0.018, 0.2], [1.38, 1.02, side * 0.34], {
        radius: 0.006,
        rotZ: 0.07,
      });
    }
    anchors.set("hood_vents", new THREE.Vector3(1.38, 1.03, 0.34));
  }

  // ---- 4. Proportional Dimensional Scaling & Stance --------------------------------------
  const scaleX = model.dimensions.length / G60.length;
  const scaleY = model.dimensions.height / G60.height;
  const scaleZ = model.dimensions.width / G60.width;
  const baselineGroundClearance = 0.14;
  const groundOffset =
    (model.dimensions.groundClearance ?? baselineGroundClearance) - baselineGroundClearance;

  root.scale.set(scaleX, scaleY, scaleZ);
  root.position.y += groundOffset;

  // Transform badge anchors into world space to match scaled geometry
  for (const [_, vec] of anchors) {
    vec.x *= scaleX;
    vec.y = vec.y * scaleY + groundOffset;
    vec.z *= scaleZ;
  }

  root.updateMatrixWorld(true);
  return {
    root,
    pieces,
    sketchLines: base.sketchLines,
    anchors,
  };
}
