import { buildPowertrain } from "../modelSwitcher/buildPowertrain";
import type { PowertrainType } from "../models/types";
import * as THREE from "three";
import { CarPowertrain } from "@reqflow/core";
import { sketchPowertrain } from "./powertrains";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { band, projectPatch, projectSketchLine, superellipse, type View } from "./decals";
import { BMW_REFERENCE } from "./reference";
import {
  bodyPanel,
  buildBodyGrid,
  G60,
  panelGeometries,
  smoothPanelEdges,
  RING,
  STATIONS,
  topLine,
  quadAt,
} from "./body";

/**
 * Assembles the whole car: the body panels from `body.ts`, plus wheels, chassis and interior built
 * from simple solids at G60 positions. Every mesh that belongs to a part carries its part id, so
 * the viewer can pick, highlight and badge it. No textures, no materials with colour here: the
 * viewer styles every piece by its `kind` so the sketch look follows the app theme.
 */

export type PieceKind =
  | "paint"
  | "glass"
  | "dark"
  | "chrome"
  | "lamp"
  | "tail"
  | "tyre"
  | "rim"
  | "metal"
  | "accent"
  | "trim"
  | "seat"
  | "screen"
  | "glow"
  | "volume"
  | "liner";

/** Exterior pieces fade out in the interior view so you can click what is inside. */
export type PieceLayer = "exterior" | "interior";

export interface CarPiece {
  mesh: THREE.Mesh;
  partId: string | null;
  kind: PieceKind;
  layer: PieceLayer;
}

export interface CarModel {
  root: THREE.Group;
  pieces: CarPiece[];
  /** Extra sketch lines (character lines on the body). */
  sketchLines: THREE.BufferGeometry[];
  /** Where each part's badge sits (world space). */
  anchors: Map<string, THREE.Vector3>;
  /** Optional exterior-only badge locations when the cabin uses a different schematic layout. */
  exteriorAnchors?: Map<string, THREE.Vector3>;
  /** Named review points on a source exterior whose original meshes are broader assemblies. */
  exteriorReviewAreas?: ReadonlyMap<string, readonly THREE.Vector3[]>;
}

const SIDES = [-1, 1] as const; // left (−z, driver in LHD), right (+z)
const DRIVER_Z = -0.38;

export function buildCar(model: PowertrainType | CarPowertrain = "electric"): CarModel {
  const powertrain = sketchPowertrain(model);
  const root = new THREE.Group();
  root.name = `BMW sedan sketch — ${powertrain} concept`;
  const pieces: CarPiece[] = [];

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
    pieces.push({ mesh, partId, kind, layer });
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
  /** Cylinder along z (axis across the car). */
  const disc = (
    partId: string | null,
    kind: PieceKind,
    layer: PieceLayer,
    radius: number,
    depth: number,
    pos: [number, number, number],
    segments = 36,
  ) =>
    add(
      new THREE.CylinderGeometry(radius, radius, depth, segments).rotateX(Math.PI / 2),
      partId,
      kind,
      layer,
      (m) => m.position.set(...pos),
    );

  // ---- Body ------------------------------------------------------------------------------
  const grid = buildBodyGrid();
  // Freeze panel membership before relaxing their shared edges. Reclassifying moved
  // vertices would reintroduce steps and small disconnected islands at window corners.
  const panelKeys = Array.from({ length: (STATIONS - 1) * RING }, (_, k) =>
    bodyPanel(quadAt(grid, Math.floor(k / RING), k % RING)),
  );
  const assignPanel = (q: Parameters<typeof bodyPanel>[0]) => panelKeys[q.i * RING + q.j]!;
  smoothPanelEdges(grid, assignPanel);
  for (const [key, geometry] of panelGeometries(grid, assignPanel)) {
    const [panel, finish] = key.split(":") as [string, string | undefined];
    const partId = panel === "underbody" ? "body" : panel;
    add(geometry, partId, (finish as PieceKind | undefined) ?? "paint", "exterior");
  }
  addBodyDetails(pieces, add, powertrain);
  const bodySurfaces = pieces
    .filter((p) => p.kind === "paint" || (p.partId === "body" && p.kind === "dark"))
    .map((p) => p.mesh);
  const sketchLines: THREE.BufferGeometry[] = [];
  for (const side of SIDES) {
    const view: View = side < 0 ? "left" : "right";
    for (const [feature, contour, inkOpacity] of [
      ["shoulder", BMW_REFERENCE.shoulder, 0.82],
      ["door_scallop", BMW_REFERENCE.lowerDoor, 0.6],
      ["sill", BMW_REFERENCE.sill, 0.44],
    ] as const) {
      const line = projectSketchLine(bodySurfaces, contour, view);
      line.userData = { feature, inkOpacity };
      sketchLines.push(line);
    }
    for (const [feature, contour] of [
      ["bonnet", BMW_REFERENCE.bonnet],
      ["rear_deck", BMW_REFERENCE.rearDeck],
    ] as const) {
      const line = projectSketchLine(
        bodySurfaces,
        contour.map(([x, z]) => [x, side * z]),
        "top",
      );
      line.userData = { feature, inkOpacity: 0.45 };
      sketchLines.push(line);
    }
  }

  // Wheel arch liners (not a part; they hide the inside of the body behind the wheels).
  for (const axle of [G60.frontAxleX, G60.rearAxleX]) {
    for (const side of SIDES) {
      add(
        new THREE.CylinderGeometry(
          G60.archRadius,
          G60.archRadius,
          0.3,
          48,
          1,
          true,
          Math.PI / 2,
          Math.PI,
        ).rotateX(Math.PI / 2),
        null,
        "liner",
        "exterior",
        (m) => m.position.set(axle, G60.tyreRadius, side * 0.78),
      );
      // Inner splash shield closes the wheel well behind the brakes. It stops
      // suspension outlines leaking through the gap above the tyre in exterior view.
      disc(null, "liner", "exterior", 0.423, 0.006, [axle, G60.tyreRadius, side * 0.68]);
    }
  }

  // ---- Mirrors, antenna --------------------------------------------------------------------
  for (const side of SIDES) {
    box("mirrors", "paint", "exterior", [0.13, 0.11, 0.22], [0.7, 1.04, side * 1.05], {
      radius: 0.045,
      rotY: side * -0.12,
    });
    box("mirrors", "paint", "exterior", [0.07, 0.03, 0.12], [0.73, 1.0, side * 0.95], {
      radius: 0.012,
    });
    box("mirrors", "dark", "exterior", [0.01, 0.085, 0.18], [0.633, 1.04, side * 1.05], {
      radius: 0.004,
      rotY: side * -0.12,
    });
  }
  {
    const fin = new THREE.Shape();
    fin.moveTo(0.02, 0);
    fin.lineTo(-0.16, 0);
    fin.quadraticCurveTo(-0.15, 0.06, -0.125, 0.066);
    fin.quadraticCurveTo(-0.05, 0.04, 0.02, 0);
    const geo = new THREE.ExtrudeGeometry(fin, {
      depth: 0.04,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.006,
      bevelSegments: 2,
    }).translate(0, 0, -0.02);
    add(geo, "antenna", "paint", "exterior", (m) => {
      m.position.set(-1.03, topLine(-1.03) - 0.004, 0);
      m.rotation.z = 0.12;
    });
  }

  // ---- Wheels, brakes, suspension ------------------------------------------------------------
  const tyreProfile = [
    [0.25, -0.105],
    [0.3, -0.118],
    [0.345, -0.121],
    [0.362, -0.113],
    [0.37, -0.09],
    [G60.tyreRadius, 0],
    [0.37, 0.09],
    [0.362, 0.113],
    [0.345, 0.121],
    [0.3, 0.118],
    [0.25, 0.105],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const halfTrack = G60.track / 2;
  for (const axle of [G60.frontAxleX, G60.rearAxleX]) {
    for (const side of SIDES) {
      const z = side * halfTrack;
      add(
        new THREE.LatheGeometry(tyreProfile, 56).rotateX(Math.PI / 2),
        "wheels",
        "tyre",
        "exterior",
        (m) => m.position.set(axle, G60.tyreRadius, z),
      );
      // Rim: barrel, lip, hub and five double spokes on the outer face.
      const face = z + side * 0.085;
      add(
        new THREE.CylinderGeometry(0.235, 0.235, 0.2, 40, 1, true).rotateX(Math.PI / 2),
        "wheels",
        "rim",
        "exterior",
        (m) => m.position.set(axle, G60.tyreRadius, z),
      );
      add(new THREE.TorusGeometry(0.238, 0.01, 8, 48), "wheels", "rim", "exterior", (m) =>
        m.position.set(axle, G60.tyreRadius, face),
      );
      disc("wheels", "rim", "exterior", 0.062, 0.04, [axle, G60.tyreRadius, face - side * 0.01]);
      for (let k = 0; k < 10; k++) {
        const a = (Math.floor(k / 2) * 2 * Math.PI) / 5 + (k % 2 ? 0.11 : -0.11);
        box(
          "wheels",
          "rim",
          "exterior",
          [0.19, 0.026, 0.022],
          [axle + Math.cos(a) * 0.145, G60.tyreRadius + Math.sin(a) * 0.145, face - side * 0.012],
          { radius: 0.008, rotZ: a },
        );
      }
      // Brake disc and caliper (M blue), visible through the spokes.
      disc(
        "brake_discs",
        "metal",
        "exterior",
        0.19,
        0.028,
        [axle, G60.tyreRadius, z + side * 0.01],
        40,
      );
      disc("brakes", "metal", "exterior", 0.08, 0.03, [axle, G60.tyreRadius, z - side * 0.015]);
      // Paired friction pads straddle the disc, inside the caliper at every wheel.
      for (const face of [-1, 1]) {
        box(
          "brake_pads",
          "dark",
          "exterior",
          [0.09, 0.05, 0.009],
          [axle - 0.13, G60.tyreRadius + 0.1, z + side * 0.01 + face * 0.019],
          { radius: 0.003, rotZ: 0.9 },
        );
      }
      box(
        "brake_calipers",
        "accent",
        "exterior",
        [0.1, 0.16, 0.06],
        [axle - 0.13, G60.tyreRadius + 0.1, z + side * 0.03],
        { radius: 0.02, rotZ: 0.9 },
      );
      // Suspension: damper with a coil spring round it, above the wheel centre.
      const damperZ = side * 0.6;
      add(new THREE.CylinderGeometry(0.028, 0.028, 0.36, 16), "dampers", "metal", "interior", (m) =>
        m.position.set(axle - 0.02, 0.6, damperZ),
      );
      add(
        new THREE.TubeGeometry(helix(0.065, 0.3, 6), 160, 0.009, 6),
        "suspension_springs",
        "accent",
        "interior",
        (m) => m.position.set(axle - 0.02, 0.45, damperZ),
      );
      // Lower control arm towards the body.
      box("control_arms", "metal", "interior", [0.08, 0.03, 0.42], [axle, 0.33, side * 0.42], {
        radius: 0.012,
      });
      box("suspension", "metal", "interior", [0.14, 0.035, 0.14], [axle - 0.02, 0.79, damperZ], {
        radius: 0.018,
      });
    }
  }

  buildPowertrain(powertrain, { add, box, disc });
  box("cooling_system", "metal", "interior", [0.07, 0.32, 0.78], [1.9, 0.57, 0], { radius: 0.012 });
  for (const z of [-0.22, 0.22])
    add(
      new THREE.TorusGeometry(0.11, 0.009, 8, 32).rotateY(Math.PI / 2),
      "cooling_system",
      "metal",
      "interior",
      (m) => m.position.set(1.845, 0.57, z),
    );

  // ---- Interior -------------------------------------------------------------------------------
  // Front seats: cushion, backrest leaning back, headrest.
  for (const side of SIDES) {
    const z = side * 0.38;
    const cushion = box("front_seats", "seat", "interior", [0.54, 0.12, 0.5], [-0.12, 0.47, z], {
      radius: 0.05,
      rotZ: 0.06,
    });
    cushion.userData.seatPosition = side < 0 ? "driver" : "front_passenger";
    seatBack(side < 0 ? "driver_seat" : "passenger_seat", -0.43, 0.82, z, 0.5, 0.64, 0.24);
  }
  // Rear seats: three places on one bench.
  for (const [z, w] of [
    [-0.45, 0.44],
    [0, 0.38],
    [0.45, 0.44],
  ] as const) {
    const cushion = box("rear_seats", "seat", "interior", [0.5, 0.13, w], [-1.02, 0.5, z], {
      radius: 0.05,
      rotZ: 0.05,
    });
    cushion.userData.seatPosition = z < 0 ? "rear_left" : z > 0 ? "rear_right" : "rear_center";
    const seatId = z < 0 ? "rear_left_seat" : z > 0 ? "rear_right_seat" : "rear_center_seat";
    seatBack(seatId, -1.33, 0.8, z, w, 0.54, 0.3);
  }
  // Belt straps sit on the backrests; each remains visible from the cabin view.
  for (const [x, y, z, lean, seatPosition] of [
    [-0.34, 0.83, -0.58, 0.24, "driver"],
    [-0.34, 0.83, 0.58, 0.24, "front_passenger"],
    [-1.24, 0.81, -0.61, 0.3, "rear_left"],
    [-1.24, 0.81, 0.09, 0.3, "rear_center"],
    [-1.24, 0.81, 0.61, 0.3, "rear_right"],
  ] as const) {
    const belt = box("seat_belts", "trim", "interior", [0.018, 0.48, 0.035], [x, y, z], {
      radius: 0.006,
      rotZ: lean,
    });
    belt.userData.seatPosition = seatPosition;
  }

  function seatBack(
    partId: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    lean: number,
  ) {
    box(partId, "seat", "interior", [0.13, h, w], [x, y, z], { radius: 0.05, rotZ: lean });
    const d = h / 2 + 0.13;
    const headrest = box(
      "headrests",
      "seat",
      "interior",
      [0.1, 0.17, Math.min(0.28, w - 0.1)],
      [x - Math.sin(lean) * d, y + Math.cos(lean) * d, z],
      { radius: 0.04, rotZ: lean },
    );
    headrest.userData.seatPosition =
      partId === "driver_seat"
        ? "driver"
        : partId === "passenger_seat"
          ? "front_passenger"
          : partId.replace("_seat", "");
  }

  // Steering wheel in front of the driver, tilted towards them.
  {
    const wheel = new THREE.Group();
    const parts = [
      new THREE.TorusGeometry(0.185, 0.019, 12, 48),
      new THREE.CylinderGeometry(0.06, 0.07, 0.05, 24).rotateX(Math.PI / 2),
      new THREE.BoxGeometry(0.15, 0.03, 0.02).translate(-0.11, -0.02, 0),
      new THREE.BoxGeometry(0.15, 0.03, 0.02).translate(0.11, -0.02, 0),
      new THREE.BoxGeometry(0.03, 0.13, 0.02).translate(0, -0.11, 0),
    ];
    for (const g of parts) wheel.add(new THREE.Mesh(g));
    wheel.updateMatrixWorld(true);
    const merged = mergeChildren(wheel);
    add(merged, "steering_wheel", "trim", "interior", (m) => {
      m.position.set(0.3, 0.93, DRIVER_Z);
      m.rotation.set(0, -Math.PI / 2, 0, "YXZ");
      m.rotateX(-0.42);
    });
    add(
      new THREE.CylinderGeometry(0.03, 0.035, 0.3, 12),
      "steering_wheel",
      "trim",
      "interior",
      (m) => {
        m.position.set(0.44, 0.88, DRIVER_Z);
        m.rotation.z = Math.PI / 2 - 0.42;
      },
    );
  }

  // Driver footwell: wide brake on the left, a taller/narrower accelerator on the right.
  // The faces point back toward the seat; hanging arms mount beneath the dashboard.
  for (const [partId, y, z, height, width, tilt] of [
    ["brake_pedal", 0.455, DRIVER_Z - 0.065, 0.095, 0.135, -0.24],
    ["accelerator_pedal", 0.415, DRIVER_Z + 0.125, 0.17, 0.06, -0.18],
  ] as const) {
    const face = box(partId, "trim", "interior", [0.028, height, width], [0.655, y, z], {
      radius: 0.009,
      rotZ: tilt,
    });
    face.userData.pedalComponent = "face";
    const arm = box(partId, "metal", "interior", [0.025, 0.205, 0.025], [0.704, 0.565, z], {
      radius: 0.005,
      rotZ: -0.3,
    });
    arm.userData.pedalComponent = "arm";
    for (const offset of [-0.3, 0, 0.3]) {
      const point = new THREE.Vector3(-0.016, height * offset, 0)
        .applyEuler(face.rotation)
        .add(face.position);
      const grip = box(partId, "dark", "interior", [0.004, 0.006, width * 0.78], point.toArray(), {
        radius: 0.001,
        rotZ: tilt,
      });
      grip.userData.pedalComponent = "grip";
    }
  }

  // Dashboard and the illuminated interaction bar.
  box("dashboard", "trim", "interior", [0.32, 0.15, 1.54], [0.71, 0.895, 0], { radius: 0.06 });
  box("dashboard", "seat", "interior", [0.16, 0.16, 1.44], [0.66, 0.74, 0], { radius: 0.05 });
  box("dashboard", "glow", "interior", [0.012, 0.022, 1.3], [0.535, 0.875, 0.05], {
    radius: 0.005,
  });
  box("glovebox", "trim", "interior", [0.035, 0.14, 0.45], [0.565, 0.735, 0.46], { radius: 0.018 });
  box("glovebox", "chrome", "interior", [0.009, 0.012, 0.09], [0.54, 0.778, 0.46], {
    radius: 0.004,
  });

  // BMW Curved Display: one curved glass panel from behind the wheel to the middle.
  {
    const R = 0.88;
    const cx = -0.33;
    add(
      new THREE.CylinderGeometry(R, R, 0.13, 48, 1, true, 1.05, 0.94),
      "curved_display",
      "screen",
      "interior",
      (m) => m.position.set(cx, 1.03, DRIVER_Z),
    );
    for (const [partId, start, span] of [
      ["instrument_cluster", 1.51, 0.47],
      ["center_touchscreen", 1.06, 0.43],
    ] as const) {
      add(
        new THREE.CylinderGeometry(R + 0.018, R + 0.018, 0.12, 32, 1, true, start, span),
        partId,
        "screen",
        "interior",
        (m) => m.position.set(cx, 1.03, DRIVER_Z),
      );
    }
    add(
      new THREE.CylinderGeometry(R + 0.012, R + 0.012, 0.145, 48, 1, true, 1.04, 0.96),
      "curved_display",
      "dark",
      "interior",
      (m) => m.position.set(cx, 1.03, DRIVER_Z),
    );
  }

  // Head-up display: the unit in the dash and its image in the windscreen.
  box("hud", "dark", "interior", [0.2, 0.04, 0.28], [0.72, 0.975, DRIVER_Z], { radius: 0.015 });
  add(new THREE.PlaneGeometry(0.3, 0.085), "hud", "glow", "interior", (m) => {
    m.position.set(0.37, 1.13, DRIVER_Z);
    m.rotation.set(0, -Math.PI / 2, 0, "YXZ");
    m.rotateX(-0.15);
  });

  // Climate: four air vents under the display and the climate control strip.
  for (const z of [-0.66, -0.14, 0.14, 0.66]) {
    box("air_vents", "dark", "interior", [0.02, 0.045, 0.17], [0.54, 0.905, z], { radius: 0.008 });
  }
  box("climate", "trim", "interior", [0.02, 0.045, 0.34], [0.54, 0.79, 0], { radius: 0.01 });

  // Centre console: tunnel, armrest, controller, gear selector, wireless charging tray.
  box("center_console", "trim", "interior", [0.82, 0.22, 0.26], [0.12, 0.52, 0], { radius: 0.05 });
  box("armrest", "trim", "interior", [0.32, 0.08, 0.24], [-0.27, 0.665, 0], {
    radius: 0.035,
  });
  add(
    new THREE.CylinderGeometry(0.036, 0.04, 0.035, 28),
    "idrive_controller",
    "chrome",
    "interior",
    (m) => m.position.set(0.0, 0.645, 0),
  );
  box("gear_selector", "dark", "interior", [0.07, 0.04, 0.05], [0.13, 0.65, 0], { radius: 0.012 });
  box("wireless_charger", "dark", "interior", [0.16, 0.012, 0.1], [0.37, 0.636, 0], {
    radius: 0.004,
  });
  for (const z of [-0.065, 0.065]) {
    add(
      new THREE.TorusGeometry(0.032, 0.004, 8, 24).rotateX(Math.PI / 2),
      "cup_holders",
      "chrome",
      "interior",
      (m) => m.position.set(0.21, 0.638, z),
    );
    box("rear_air_vents", "dark", "interior", [0.025, 0.05, 0.08], [-0.305, 0.57, z], {
      radius: 0.006,
    });
  }

  // Sound system: woofers in the doors, tweeters in the dash corners, centre speaker.
  for (const side of SIDES) {
    for (const x of [0.4, -0.8]) {
      add(
        new THREE.CylinderGeometry(0.075, 0.075, 0.03, 28).rotateX(Math.PI / 2),
        "door_speakers",
        "dark",
        "interior",
        (m) => m.position.set(x, 0.46, side * 0.86),
      );
    }
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 20), "tweeters", "dark", "interior", (m) =>
      m.position.set(0.8, 0.965, side * 0.68),
    );
  }
  box("sound_system", "dark", "interior", [0.1, 0.015, 0.22], [0.82, 0.965, 0.25], {
    radius: 0.005,
  });

  // Ambient light strips along the doors and the headliner with its reading lights.
  for (const side of SIDES) {
    box("ambient_light", "glow", "interior", [1.7, 0.01, 0.01], [-0.35, 0.8, side * 0.87], {
      radius: 0.004,
    });
  }
  box("headliner", "volume", "interior", [0.9, 0.014, 1.15], [-0.6, 1.42, 0], {
    radius: 0.006,
  });
  box("reading_lights", "glow", "interior", [0.07, 0.016, 0.12], [-0.2, 1.41, 0], {
    radius: 0.006,
  });

  // Driver assistance: the camera module behind the windscreen (radar sits in the grille).
  box("driver_assistance", "dark", "interior", [0.1, 0.06, 0.16], [0.18, 1.28, 0], {
    radius: 0.015,
  });

  // Luggage space as a volume in the boot.
  box("luggage", "volume", "interior", [0.62, 0.42, 1.2], [-1.95, 0.72, 0], { radius: 0.04 });

  root.updateMatrixWorld(true);
  return { root, pieces, sketchLines, anchors: anchorsFor(pieces) };
}

/** Grille, lights, handles and charge flap, projected onto the body panels already built. */
function addBodyDetails(
  pieces: CarPiece[],
  add: (g: THREE.BufferGeometry, partId: string, kind: PieceKind, layer: PieceLayer) => void,
  powertrain: PowertrainType,
) {
  const panels = (...ids: string[]) =>
    pieces
      .filter((p) => p.kind === "paint" && p.partId !== null && ids.includes(p.partId))
      .map((p) => p.mesh);
  const front = panels("front_bumper", "hood");
  const rear = panels("rear_bumper", "trunk_lid", "body");
  const sides = panels("front_doors", "rear_doors", "body");
  const put = (
    partId: string,
    kind: PieceKind,
    targets: THREE.Mesh[],
    shape: Parameters<typeof projectPatch>[1],
    uSeg: number,
    vSeg: number,
    view: View,
    lift?: number,
    detail?: string,
  ) => {
    const geo = projectPatch(targets, shape, uSeg, vSeg, view, lift);
    if (geo) {
      if (detail) geo.userData.detail = detail;
      add(geo, partId, kind, "exterior");
    }
  };

  for (const s of SIDES) {
    const side: View = s < 0 ? "left" : "right";
    for (const axle of [G60.frontAxleX, G60.rearAxleX]) {
      put(
        "body",
        "chrome",
        sides,
        (u, v) => {
          const angle = -0.4 + u * (Math.PI + 0.8);
          const radius = G60.archRadius + 0.013 + 0.004 * v;
          return [axle + Math.cos(angle) * radius, G60.tyreRadius + Math.sin(angle) * radius];
        },
        64,
        1,
        side,
        0.003,
      );
    }
    // Broad, slightly angular kidneys with a narrow central bridge and vertical slats.
    const kidney = (r0: number, r1: number) => {
      const curve = new THREE.CatmullRomCurve3(
        [
          [-0.95, 0.68],
          [-0.72, 0.94],
          [0.7, 1],
          [0.98, 0.67],
          [0.9, -0.65],
          [0.62, -0.96],
          [-0.76, -0.89],
          [-0.98, -0.6],
        ].map(([a, b]) => new THREE.Vector3(a, b, 0)),
        true,
        "centripetal",
        0.2,
      );
      return (u: number, v: number): [number, number] => {
        const p = curve.getPoint(u);
        const r = r0 + (r1 - r0) * v;
        return [s * (0.205 + p.x * 0.182 * r), 0.632 + p.y * 0.151 * r];
      };
    };
    put("kidney_grille", "dark", front, kidney(0, 0.9), 48, 4, "front");
    put("kidney_grille", "glow", front, kidney(0.9, 1), 48, 1, "front", 0.005);
    for (const z of [0.095, 0.15, 0.205, 0.26, 0.315]) {
      put(
        "kidney_grille",
        "chrome",
        front,
        band(
          s * (z - 0.003),
          s * (z + 0.003),
          () => 0.527,
          () => 0.741,
        ),
        1,
        10,
        "front",
        0.008,
      );
    }
    // Slim headlights at the top of the face, wrapping round the corner.
    put(
      "headlights",
      "lamp",
      front,
      band(
        s * 0.42,
        s * 0.86,
        (u) => 0.755 + 0.025 * u,
        (u) => 0.825 + 0.003 * u,
      ),
      28,
      3,
      "front",
    );
    // Twin LED signatures, each with a short horizontal foot and an upright stroke.
    put(
      "headlights",
      "glow",
      front,
      band(
        s * 0.49,
        s * 0.58,
        () => 0.785,
        () => 0.794,
      ),
      28,
      1,
      "front",
      0.007,
    );
    for (const z of [0.58, 0.745]) {
      put(
        "headlights",
        "glow",
        front,
        band(
          s * (z - 0.012),
          s * z,
          (u) => 0.79 + 0.019 * u,
          (u) => 0.802 + 0.019 * u,
        ),
        3,
        1,
        "front",
        0.009,
      );
    }
    put(
      "headlights",
      "glow",
      front,
      band(
        s * 0.655,
        s * 0.745,
        () => 0.79,
        () => 0.799,
      ),
      8,
      1,
      "front",
      0.007,
    );
    // Outer air curtains and an angular lower apron frame the central intake.
    put(
      "front_bumper",
      "dark",
      front,
      superellipse(s * 0.737, 0.425, 0.087, 0.096, 4),
      32,
      3,
      "front",
    );
    // Tail lights: across the back and round onto the sides.
    put(
      "taillights",
      "tail",
      rear,
      band(
        s * 0.3,
        s * 0.88,
        (u) => 0.986 + 0.012 * u,
        (u) => 1.026 + 0.012 * u,
      ),
      28,
      3,
      "rear",
    );
    put(
      "taillights",
      "tail",
      sides,
      band(
        -2.5,
        -2.27,
        () => 0.985,
        () => 1.035,
      ),
      12,
      3,
      side,
    );
    // Slim paired LED strokes inside the rear lamp housing.
    for (const y of [0.998, 1.017]) {
      put(
        "taillights",
        "glow",
        rear,
        band(
          s * 0.335,
          s * 0.855,
          (u) => y + 0.012 * u,
          (u) => y + 0.006 + 0.012 * u,
        ),
        32,
        1,
        "rear",
        0.009,
        "rear_led",
      );
    }
    // Reflectors and flush parking sensors in the bumper, without adding new parts.
    put(
      "rear_bumper",
      "tail",
      rear,
      superellipse(s * 0.742, 0.465, 0.081, 0.019, 5),
      28,
      2,
      "rear",
      0.005,
      "rear_reflector",
    );
    for (const z of [0.29, 0.64]) {
      put(
        "rear_bumper",
        "chrome",
        rear,
        superellipse(s * z, 0.58, 0.014, 0.014, 2, 0.82, 1),
        20,
        1,
        "rear",
        0.005,
        "parking_sensor",
      );
    }
    // Flush door handles on both doors.
    for (const [x, y] of [
      [-0.1, 0.95],
      [-1.17, 0.992],
    ] as const) {
      put("door_handles", "chrome", sides, superellipse(x, y, 0.075, 0.014, 6), 32, 2, side);
    }
  }
  put("front_bumper", "dark", front, superellipse(0, 0.355, 0.535, 0.06, 5), 64, 4, "front");
  put("rear_bumper", "dark", rear, superellipse(0, 0.36, 0.66, 0.065, 5), 48, 3, "rear");
  for (const z of [-0.42, -0.21, 0, 0.21, 0.42]) {
    put(
      "rear_bumper",
      "chrome",
      rear,
      band(
        z - 0.007,
        z + 0.007,
        () => 0.319,
        () => 0.397,
      ),
      1,
      8,
      "rear",
      0.01,
      "diffuser_rib",
    );
  }

  // A low deck lip follows the curved rear corners, rather than floating above them.
  const lip = projectPatch(
    rear,
    (u, v) => {
      const z = (u - 0.5) * 1.42;
      return [-2.445 + 0.07 * v + 0.11 * (z / 0.71) ** 4, z];
    },
    64,
    3,
    "top",
    0.005,
  );
  if (lip) {
    const positions = lip.getAttribute("position");
    for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getY(i) + 0.012);
    lip.computeVertexNormals();
    lip.userData.detail = "trunk_lip";
    add(lip, "trunk_lid", "chrome", "exterior");
  }
  put(
    "trunk_lid",
    "dark",
    rear,
    superellipse(0, 0.803, 0.292, 0.087, 5),
    48,
    4,
    "rear",
    0.005,
    "plate_recess",
  );
  put(
    "trunk_lid",
    "chrome",
    rear,
    superellipse(0, 0.803, 0.254, 0.061, 5),
    48,
    3,
    "rear",
    0.009,
    "plate_surround",
  );
  put(
    "trunk_lid",
    "chrome",
    rear,
    superellipse(0, 0.969, 0.031, 0.031, 2, 0.74, 1),
    32,
    1,
    "rear",
    0.009,
    "rear_roundel",
  );
  put(
    "trunk_lid",
    "dark",
    rear,
    superellipse(0, 0.919, 0.088, 0.01, 5),
    32,
    2,
    "rear",
    0.007,
    "trunk_handle",
  );
  // Small roundel above the grille, sharing the bonnet's existing part id.
  put(
    "hood",
    "chrome",
    front,
    superellipse(2.015, 0, 0.031, 0.031, 2, 0.72, 1),
    32,
    1,
    "top",
    0.004,
  );
  put(
    "driver_assistance",
    "dark",
    front,
    superellipse(0, 0.39, 0.065, 0.028, 4),
    32,
    2,
    "front",
    0.008,
  );
  const refillPart =
    powertrain === "electric" || powertrain === "hybrid"
      ? "charging_port"
      : powertrain === "h2"
        ? "h2_storage"
        : "fuel_system";
  put(refillPart, "dark", sides, superellipse(-1.79, 0.895, 0.075, 0.05, 4), 32, 3, "right");
  if (powertrain === "hybrid")
    put("fuel_system", "dark", sides, superellipse(-1.79, 0.895, 0.075, 0.05, 4), 32, 3, "left");
}

/** A helix along +y (coil spring). */
function helix(radius: number, height: number, turns: number): THREE.Curve<THREE.Vector3> {
  const pts: THREE.Vector3[] = [];
  const n = turns * 24;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, t * height, Math.sin(a) * radius));
  }
  return new THREE.CatmullRomCurve3(pts);
}

/** Merges a group's (non-indexed) child geometries into one, in the group's space. */
function mergeChildren(group: THREE.Group): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const source = o.geometry as THREE.BufferGeometry;
    const g = source.index ? source.toNonIndexed() : source.clone();
    g.applyMatrix4(o.matrixWorld);
    positions.push(...(g.getAttribute("position").array as Float32Array));
    normals.push(...(g.getAttribute("normal").array as Float32Array));
    g.dispose();
    source.dispose();
    (o.material as THREE.Material).dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

/** Badge positions where the default view (front left) sees them. */
const ANCHOR_OVERRIDES: Record<string, [number, number, number]> = {
  wheels: [G60.frontAxleX, G60.tyreRadius, -1.0],
  brakes: [G60.rearAxleX - 0.12, G60.tyreRadius + 0.1, -0.95],
  brake_pads: [G60.frontAxleX - 0.13, G60.tyreRadius + 0.1, -G60.track / 2 - 0.019],
  accelerator_pedal: [0.655, 0.415, DRIVER_Z + 0.125],
  brake_pedal: [0.655, 0.455, DRIVER_Z - 0.065],
  suspension: [G60.frontAxleX, 0.72, -0.62],
  front_doors: [0.35, 0.7, -0.97],
  rear_doors: [-0.75, 0.7, -0.97],
  door_handles: [-0.1, 0.93, -0.97],
  side_windows: [0.05, 1.18, -0.82],
  mirrors: [0.7, 1.1, -1.08],
  headlights: [2.1, 0.8, -0.65],
  taillights: [-2.3, 1.0, -0.7],
  front_seats: [-0.2, 0.9, DRIVER_Z],
  rear_seats: [-1.15, 0.9, -0.45],
  sound_system: [0.4, 0.46, -0.9],
  ambient_light: [-0.35, 0.8, -0.88],
  body: [-1.75, 0.75, -0.97],
  roof: [-0.55, 1.52, 0],
  kidney_grille: [2.2, 0.63, 0],
  front_bumper: [2.1, 0.36, -0.5],
  rear_bumper: [-2.45, 0.6, -0.5],
  drivetrain: [0.4, 0.26, -0.72],
  luggage: [-1.95, 0.95, 0],
};

function anchorsFor(pieces: CarPiece[]): Map<string, THREE.Vector3> {
  const boxes = new Map<string, THREE.Box3>();
  for (const { mesh, partId } of pieces) {
    if (!partId) continue;
    const b = new THREE.Box3().setFromObject(mesh);
    const prev = boxes.get(partId);
    boxes.set(partId, prev ? prev.union(b) : b);
  }
  const anchors = new Map<string, THREE.Vector3>();
  for (const [partId, b] of boxes) {
    const o = ANCHOR_OVERRIDES[partId];
    anchors.set(partId, o ? new THREE.Vector3(...o) : b.getCenter(new THREE.Vector3()));
  }
  return anchors;
}
