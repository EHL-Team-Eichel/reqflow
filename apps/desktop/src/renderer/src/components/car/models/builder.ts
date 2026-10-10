import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { buildCar, type CarModel, type CarPiece, type PieceKind, type PieceLayer } from "../model/buildCar";
import { G60 } from "../model/body";
import type { PowertrainType, VehicleModel } from "./types";

/**
 * Builds a 3D car model based on the baseline blueprint (`buildCar`), customized
 * for the selected vehicle model's dimensions, body style, powertrain architecture,
 * and car-specific aerodynamic/chassis components (spoilers, splitters, diffusers,
 * roll cages, roof rails, etc.).
 */
export function buildVehicleModel(
  model?: VehicleModel,
  powertrain: PowertrainType = "gasoline",
): CarModel {
  const base = buildCar();
  if (!model) return base;

  const root = base.root;
  root.name = `${model.name} (${model.chassisCode}) — ${powertrain}`;
  const pieces = base.pieces;
  const anchors = base.anchors;

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

  const disc = (
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    radius: number,
    depth: number,
    pos: [number, number, number],
    segments = 28,
  ) =>
    add(
      new THREE.CylinderGeometry(radius, radius, depth, segments).rotateX(Math.PI / 2),
      partId,
      kind,
      layer,
      (m) => m.position.set(...pos),
    );

  const frontAxleX = G60.frontAxleX;
  const rearAxleX = G60.rearAxleX;
  const frontX = G60.frontX;
  const rearX = G60.rearX;
  const halfTrack = G60.track / 2;
  const tyreRadius = G60.tyreRadius;

  // ---- Powertrain Specific Components ----------------------------------------------------
  if (powertrain === "gasoline") {
    // Hide underfloor battery pack
    for (const p of pieces) {
      if (p.partId === "battery_pack") p.mesh.visible = false;
    }
    // TwinPower Turbo engine block (Inline-6 or V8)
    box("motor", "metal", "interior", [0.72, 0.44, 0.46], [frontAxleX + 0.05, 0.62, 0], {
      radius: 0.04,
    });
    // Engine cylinder head cover with M Power badge styling
    box("motor", "dark", "interior", [0.66, 0.09, 0.36], [frontAxleX + 0.05, 0.86, 0], {
      radius: 0.02,
    });
    // Intake manifold / turbochargers
    box("motor", "accent", "interior", [0.38, 0.16, 0.18], [frontAxleX + 0.12, 0.72, 0.26], {
      radius: 0.02,
    });
    // Fuel tank under rear bench
    box("fuel_system", "dark", "interior", [0.55, 0.24, 1.15], [-1.02, 0.38, 0], {
      radius: 0.04,
    });
    anchors.set("fuel_system", new THREE.Vector3(-1.02, 0.38, 0));

    // Exhaust system: mid-muffler, rear muffler box and dual or quad chrome exhaust tips
    box("exhaust_system", "metal", "interior", [0.52, 0.18, 0.42], [-0.2, 0.22, 0], {
      radius: 0.03,
    });
    box("exhaust_system", "metal", "exterior", [0.34, 0.18, 0.88], [rearX + 0.35, 0.32, 0], {
      radius: 0.04,
    });
    // Quad exhaust tips protruding past rear bumper
    const quadTips =
      model.specialParts.includes("gt_wing") ||
      model.series.startsWith("M") ||
      model.name.includes("M") ||
      model.name.includes("CS") ||
      model.name.includes("GTS");

    const tipZPositions = quadTips ? [-0.44, -0.34, 0.34, 0.44] : [-0.38, 0.38];
    for (const z of tipZPositions) {
      disc("exhaust_system", "chrome", "exterior", 0.046, 0.16, [rearX - 0.04, 0.29, z]);
      disc("exhaust_system", "dark", "exterior", 0.038, 0.165, [rearX - 0.04, 0.29, z]);
    }
    anchors.set("exhaust_system", new THREE.Vector3(rearX - 0.04, 0.29, 0));
  } else if (powertrain === "hybrid") {
    // Hybrid: smaller internal combustion engine + electric motor + hybrid battery
    box("motor", "metal", "interior", [0.56, 0.4, 0.42], [frontAxleX + 0.1, 0.6, 0], {
      radius: 0.03,
    });
    box("motor", "dark", "interior", [0.5, 0.08, 0.32], [frontAxleX + 0.1, 0.82, 0], {
      radius: 0.02,
    });
    box("fuel_system", "dark", "interior", [0.42, 0.2, 0.95], [-1.05, 0.38, 0], {
      radius: 0.03,
    });
    anchors.set("fuel_system", new THREE.Vector3(-1.05, 0.38, 0));

    // Dual exhaust tips
    for (const z of [-0.36, 0.36]) {
      disc("exhaust_system", "chrome", "exterior", 0.042, 0.15, [rearX - 0.03, 0.29, z]);
      disc("exhaust_system", "dark", "exterior", 0.035, 0.155, [rearX - 0.03, 0.29, z]);
    }
    anchors.set("exhaust_system", new THREE.Vector3(rearX - 0.03, 0.29, 0));
  } else if (powertrain === "h2") {
    // Hydrogen: Fuel Cell stack + 700-bar carbon composite H2 storage cylinders
    for (const p of pieces) {
      if (p.partId === "battery_pack") p.mesh.visible = false;
    }
    // Fuel cell stack under bonnet
    box("motor", "metal", "interior", [0.65, 0.42, 0.52], [frontAxleX + 0.05, 0.62, 0], {
      radius: 0.03,
    });
    box("motor", "accent", "interior", [0.5, 0.12, 0.4], [frontAxleX + 0.05, 0.84, 0], {
      radius: 0.02,
    });
    // Longitudinal 700-bar carbon-fibre H2 tank in tunnel
    disc("h2_storage", "dark", "interior", 0.13, 1.45, [-0.1, 0.34, 0]);
    // Transverse 700-bar H2 tank under rear seats
    add(
      new THREE.CylinderGeometry(0.14, 0.14, 1.15, 24).rotateZ(Math.PI / 2),
      "h2_storage",
      "dark",
      "interior",
      (m) => m.position.set(-1.05, 0.38, 0),
    );
    anchors.set("h2_storage", new THREE.Vector3(-0.5, 0.35, 0));

    // Buffer battery pack (compact 35 kWh)
    box("battery_pack", "dark", "interior", [1.1, 0.09, 1.1], [-0.05, 0.25, 0], { radius: 0.02 });

    // Water-vapor exhaust port
    disc("exhaust_system", "metal", "exterior", 0.032, 0.09, [rearX - 0.02, 0.28, 0.34]);
    anchors.set("exhaust_system", new THREE.Vector3(rearX - 0.02, 0.28, 0.34));
  } else {
    // Electric: standard clean electric setup with full underfloor battery
    anchors.set("charging_port", new THREE.Vector3(-1.6, 0.95, -0.88));
  }

  // ---- Car-Specific Components -----------------------------------------------------------
  const specialParts = model.specialParts;
  const deckY = 1.14;

  // 1. GT Wing / Motorsport Wing
  if (specialParts.includes("gt_wing")) {
    // Twin curved carbon upright stanchions mounted to trunk deck
    box("rear_spoiler", "dark", "exterior", [0.07, 0.28, 0.035], [rearX + 0.28, deckY + 0.14, -0.46], {
      radius: 0.008,
      rotZ: -0.15,
    });
    box("rear_spoiler", "dark", "exterior", [0.07, 0.28, 0.035], [rearX + 0.28, deckY + 0.14, 0.46], {
      radius: 0.008,
      rotZ: -0.15,
    });
    // Main inverted aerodynamic carbon wing blade
    box("rear_spoiler", "dark", "exterior", [0.32, 0.035, 1.48], [rearX + 0.24, deckY + 0.28, 0], {
      radius: 0.012,
      rotZ: 0.08,
    });
    // Aerodynamic vertical endplates
    box("rear_spoiler", "dark", "exterior", [0.34, 0.16, 0.018], [rearX + 0.24, deckY + 0.28, -0.74], {
      radius: 0.006,
    });
    box("rear_spoiler", "dark", "exterior", [0.34, 0.16, 0.018], [rearX + 0.24, deckY + 0.28, 0.74], {
      radius: 0.006,
    });
    anchors.set("rear_spoiler", new THREE.Vector3(rearX + 0.24, deckY + 0.28, 0));
  } else if (specialParts.includes("duckbill_spoiler") || specialParts.includes("rear_spoiler")) {
    // Sculpted aerodynamic duckbill spoiler or lip spoiler along rear trunk edge
    box("rear_spoiler", "dark", "exterior", [0.14, 0.065, 1.18], [rearX + 0.08, deckY + 0.035, 0], {
      radius: 0.015,
      rotZ: 0.4,
    });
    anchors.set("rear_spoiler", new THREE.Vector3(rearX + 0.08, deckY + 0.06, 0));
  }

  // 2. Front Splitter & Canards
  if (specialParts.includes("front_splitter")) {
    // Protruding carbon front splitter blade
    box("front_splitter", "dark", "exterior", [0.24, 0.026, 1.76], [frontX + 0.09, 0.21, 0], {
      radius: 0.01,
    });
    // Dual tie-rod turnbuckle support struts
    box("front_splitter", "metal", "exterior", [0.012, 0.13, 0.012], [frontX + 0.11, 0.28, -0.34], {
      rotZ: 0.38,
    });
    box("front_splitter", "metal", "exterior", [0.012, 0.13, 0.012], [frontX + 0.11, 0.28, 0.34], {
      rotZ: 0.38,
    });
    anchors.set("front_splitter", new THREE.Vector3(frontX + 0.12, 0.22, 0));
  }

  if (specialParts.includes("canards")) {
    // Dual aerodynamic dive planes / canards on front bumper corners
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
    // Underbody aerodynamic diffuser tray
    box("rear_diffuser", "dark", "exterior", [0.42, 0.07, 1.32], [rearX + 0.24, 0.27, 0], {
      radius: 0.02,
      rotZ: -0.24,
    });
    // 4 vertical aerodynamic guide fins / strakes
    for (const z of [-0.48, -0.16, 0.16, 0.48]) {
      box("rear_diffuser", "dark", "exterior", [0.36, 0.075, 0.018], [rearX + 0.24, 0.25, z], {
        rotZ: -0.24,
      });
    }
    anchors.set("rear_diffuser", new THREE.Vector3(rearX + 0.15, 0.25, 0));
  }

  // 4. Widebody Kit & Arch Flares
  if (specialParts.includes("widebody_flares")) {
    // Front arch blister flares
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
      // Side skirt extensions connecting the flared arches
      box(
        "widebody_flares",
        "dark",
        "exterior",
        [frontAxleX - rearAxleX - 0.7, 0.05, 0.06],
        [(frontAxleX + rearAxleX) / 2, 0.23, side * (halfTrack + 0.05)],
        { radius: 0.015 },
      );
    }
    anchors.set("widebody_flares", new THREE.Vector3(frontAxleX, tyreRadius + 0.2, halfTrack + 0.06));
  }

  // 5. Motorsport Safety Roll Cage
  if (specialParts.includes("roll_cage")) {
    const cageZ = 0.52;
    // B-Pillar main roll hoop
    box("roll_cage", "accent", "interior", [0.045, 0.82, 0.045], [-0.46, 0.95, -cageZ], {
      radius: 0.02,
    });
    box("roll_cage", "accent", "interior", [0.045, 0.82, 0.045], [-0.46, 0.95, cageZ], {
      radius: 0.02,
    });
    box("roll_cage", "accent", "interior", [0.045, 0.045, cageZ * 2], [-0.46, 1.34, 0], {
      radius: 0.02,
    });
    // Diagonal X-bracing in rear cabin
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
      // Foot mountings
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

  root.updateMatrixWorld(true);
  return {
    root,
    pieces,
    sketchLines: base.sketchLines,
    anchors,
  };
}
