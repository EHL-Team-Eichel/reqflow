import * as THREE from "three";
import type { CarPiece, PieceKind, PieceLayer } from "../model/buildCar";
import { G60 } from "../model/body";
import type { PowertrainType } from "../models/types";

type Triple = [number, number, number];
interface Builders {
  add: (
    geometry: THREE.BufferGeometry,
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    place?: (mesh: THREE.Mesh) => void,
  ) => THREE.Mesh;
  box: (
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    size: Triple,
    pos: Triple,
    opts?: { radius?: number; rotZ?: number; rotY?: number; rotX?: number },
  ) => THREE.Mesh;
  disc: (
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    radius: number,
    depth: number,
    pos: Triple,
    segments?: number,
  ) => THREE.Mesh;
}

/** Procedural layouts: shared body/cabin geometry stays owned by buildCar. */
export function buildPowertrain(powertrain: PowertrainType, { add, box, disc }: Builders) {
  const SIDES = [-1, 1] as const;
  const electric = powertrain === "electric";
  const combustion = powertrain === "hybrid" || powertrain === "gasoline";
  if (powertrain !== "gasoline") {
    const size: Triple = electric
      ? [2.5, 0.11, 1.42]
      : powertrain === "hybrid"
        ? [0.85, 0.12, 1.12]
        : [0.5, 0.13, 0.68];
    const position: Triple = electric ? [-0.05, 0.255, 0] : [-0.85, 0.28, 0];
    box("battery_pack", "dark", "interior", size, position, { radius: 0.03 });
  }
  // Chassis support remains the selectable home for broad drivetrain requirements.
  box("drivetrain", "metal", "interior", [2.6, 0.035, 1.35], [-0.05, 0.18, 0], { radius: 0.012 });
  for (const axle of [G60.frontAxleX, G60.rearAxleX]) {
    const motorId = axle === G60.frontAxleX ? "motor" : "rear_motor";
    if (electric || (powertrain !== "gasoline" && axle === G60.rearAxleX)) {
      disc(motorId, "metal", "interior", 0.13, 0.36, [axle, 0.42, 0], 32);
      // End caps and raised ribs give each motor an identifiable casing.
      for (const z of [-0.185, 0.185])
        disc(motorId, "metal", "interior", 0.115, 0.025, [axle, 0.42, z], 28);
      for (const z of [-0.1, 0, 0.1])
        add(new THREE.TorusGeometry(0.133, 0.007, 6, 32), motorId, "metal", "interior", (m) =>
          m.position.set(axle, 0.42, z),
        );
    }
    for (const side of SIDES) {
      add(
        new THREE.CylinderGeometry(0.022, 0.022, 0.52, 10).rotateX(Math.PI / 2),
        "drive_shafts",
        "metal",
        "interior",
        (m) => m.position.set(axle, 0.39, side * 0.45),
      );
    }
  }
  box("transmission", "metal", "interior", [0.3, 0.22, 0.25], [G60.frontAxleX - 0.24, 0.43, 0.04], {
    radius: 0.035,
  });
  box("differential", "metal", "interior", [0.21, 0.18, 0.22], [G60.rearAxleX + 0.2, 0.4, 0], {
    radius: 0.04,
  });
  if (powertrain !== "gasoline") {
    box("inverter", "dark", "interior", [0.3, 0.12, 0.35], [G60.frontAxleX, 0.64, 0], {
      radius: 0.025,
    });
  }

  if (combustion) {
    box("combustion_engine", "metal", "interior", [0.56, 0.42, 0.56], [G60.frontAxleX, 0.56, 0], {
      radius: 0.05,
    });
    box("combustion_engine", "dark", "interior", [0.52, 0.055, 0.5], [G60.frontAxleX, 0.795, 0], {
      radius: 0.02,
    });
    for (const x of [-0.18, -0.06, 0.06, 0.18])
      box(
        "combustion_engine",
        "chrome",
        "interior",
        [0.015, 0.02, 0.4],
        [G60.frontAxleX + x, 0.83, 0],
        { radius: 0.005 },
      );
    box("fuel_system", "dark", "interior", [0.64, 0.22, 0.65], [-1.1, 0.27, 0.47], {
      radius: 0.05,
    });
    const pipe = new THREE.CatmullRomCurve3([
      new THREE.Vector3(G60.frontAxleX, 0.36, 0.3),
      new THREE.Vector3(0.5, 0.19, 0.42),
      new THREE.Vector3(-1.1, 0.19, 0.42),
      new THREE.Vector3(-2.35, 0.3, 0.48),
    ]);
    add(new THREE.TubeGeometry(pipe, 48, 0.028, 10), "exhaust_system", "metal", "interior");
    box("exhaust_system", "metal", "interior", [0.42, 0.13, 0.28], [-1.98, 0.25, 0.48], {
      radius: 0.04,
    });
    for (const z of [0.43, 0.55]) {
      add(
        new THREE.CylinderGeometry(0.039, 0.039, 0.18, 24, 1, true).rotateZ(Math.PI / 2),
        "exhaust_system",
        "chrome",
        "exterior",
        (m) => m.position.set(-2.49, 0.32, z),
      );
    }
  }
  if (powertrain === "h2") {
    box("fuel_cell", "metal", "interior", [0.65, 0.32, 0.65], [G60.frontAxleX, 0.58, 0], {
      radius: 0.035,
    });
    for (let i = 0; i < 9; i++)
      box(
        "fuel_cell",
        "accent",
        "interior",
        [0.016, 0.34, 0.66],
        [G60.frontAxleX - 0.26 + i * 0.065, 0.58, 0],
        { radius: 0.004 },
      );
    // Two cylinders along the centre tunnel, replacing the large traction battery.
    for (const x of [0.25, -1.15]) {
      add(
        new THREE.CapsuleGeometry(0.16, 0.76, 8, 24).rotateZ(Math.PI / 2),
        "h2_storage",
        "accent",
        "interior",
        (m) => m.position.set(x, 0.33, 0),
      );
    }
  }
}
