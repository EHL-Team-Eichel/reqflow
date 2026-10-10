import * as THREE from "three";
import { BMW_REFERENCE } from "./reference";

/**
 * The car body as one smooth parametric surface, cut into panels.
 *
 * Built procedurally with contours traced from the supplied Hot Wheels BMW STL.
 * The nose and bonnet are shortened for the sketch: 4,730 mm overall, with the original
 * 1,900 mm width and 1,515 mm roof height. The STL guides the silhouette and creases;
 * panels and cabin components remain separate, selectable procedural forms.
 *
 * Axes: x forward (front bumper at +2.20, rear at −2.53), y up, z to the car's right; metres.
 * The surface is a tube: one cross-section ring per station along x. Each ring runs through ten
 * control points per side (bottom → sill → side → shoulder → belt → glass → roof). Every quad of
 * the grid is then given to one panel (hood, front door, windscreen, …) by where it sits, so the
 * panels share vertices and normals and the car shades as one smooth surface.
 */

export const G60 = {
  length: 4.73,
  frontX: 2.2,
  rearX: -2.53,
  width: 1.9,
  height: 1.515,
  wheelbase: BMW_REFERENCE.frontAxleX - BMW_REFERENCE.rearAxleX,
  frontAxleX: BMW_REFERENCE.frontAxleX,
  rearAxleX: BMW_REFERENCE.rearAxleX,
  track: 1.63,
  tyreRadius: 0.37,
  tyreWidth: 0.245,
  rimRadius: 0.245,
  archRadius: 0.425,
} as const;

type Pt = readonly [number, number];

/** Smooth curve y(x) through key points (cubic Hermite, Catmull-Rom tangents), clamped at the ends. */
export function profile(points: readonly Pt[]): (x: number) => number {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const last = p.length - 1;
  return (x) => {
    if (x <= p[0]![0]) return p[0]![1];
    if (x >= p[last]![0]) return p[last]![1];
    let i = 0;
    while (x > p[i + 1]![0]) i++;
    const p0 = p[Math.max(0, i - 1)]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[Math.min(last, i + 2)]!;
    const dx = p2[0] - p1[0];
    const t = (x - p1[0]) / dx;
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * dx;
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * dx;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * p1[1] +
      (t3 - 2 * t2 + t) * m1 +
      (-2 * t3 + 3 * t2) * p2[1] +
      (t3 - t2) * m2
    );
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Side view: the top line (bumper → bonnet → windscreen → roof → rear window → boot → bumper). */
export const topLine = profile(BMW_REFERENCE.top);

/** Window line (the lower edge of the side glass); rises slightly to the rear. */
export const beltLine = profile([
  [0.9, 0.975],
  [0.0, 0.99],
  [-1.0, 1.015],
  [-1.6, 1.05],
  [-1.95, 1.085],
  [-2.15, 1.11],
]);

/** Side view: the bottom line (front apron → sills → rear apron). */
export const bottomLine = profile([
  [2.2, 0.34],
  [2.14, 0.26],
  [1.96, 0.205],
  [1.0, 0.165],
  [-1.0, 0.165],
  [-2.0, 0.22],
  [-2.42, 0.28],
  [-2.5, 0.33],
  [-2.53, 0.38],
]);

const baseHalfWidth = profile(BMW_REFERENCE.halfWidth);

const NOSE_START = 1.82;
const TAIL_START = -2.2;

/** Plan view: half the body width; the ends round off like a superellipse. */
export function halfWidth(x: number): number {
  let w = baseHalfWidth(x);
  if (x > NOSE_START) {
    const s = Math.min(1, (x - NOSE_START) / (G60.frontX - NOSE_START));
    w *= Math.pow(Math.max(0, 1 - Math.pow(s, 2.6)), 1 / 2.6);
  }
  if (x < TAIL_START) {
    const s = Math.min(1, (TAIL_START - x) / (TAIL_START - G60.rearX));
    w *= Math.pow(Math.max(0, 1 - Math.pow(s, 3.6)), 1 / 3.6);
  }
  return w;
}

/** Samples per segment of the cross-section and number of segments per side. */
const PER_SEG = 10;
const HALF_SEGS = 9;
/** Ring points: both sides, closed loop (bottom centre and top centre shared). */
export const RING = PER_SEG * HALF_SEGS * 2;
export const STATIONS = 170;

/**
 * Segment of the cross-section a ring index belongs to, counted on one side from the bottom:
 * 0 floor · 1 sill · 2 lower side · 3 upper side · 4 shoulder → belt · 5–6 side glass · 7–8 roof.
 * Where there is no greenhouse (bonnet, boot) 5–8 are the top of the bonnet or boot lid.
 */
export function segmentOf(ringIndex: number): number {
  const seg = Math.floor(ringIndex / PER_SEG) % (HALF_SEGS * 2);
  return seg < HALF_SEGS ? seg : HALF_SEGS * 2 - 1 - seg;
}

/** Ring index on the right-hand side (z > 0) where segment `seg` starts. */
export const ringIndexOf = (seg: number) => seg * PER_SEG;

interface Section {
  x: number;
  /** 0 = no greenhouse (bonnet, boot) … 1 = full side window. */
  glass: number;
  points: THREE.Vector3[];
}

function section(x: number): Section {
  const w = halfWidth(x);
  const yt = topLine(x);
  const yb = bottomLine(x);
  const ybe = Math.min(beltLine(x), yt - 0.03);
  const h = yt - ybe;
  const g = smoothstep(0.06, 0.3, h);
  const wr = lerp(0.86 * w, Math.min(0.67, 0.86 * w), g);
  // Right-hand side, bottom centre → top centre (z, y).
  const half: Pt[] = [
    [0, yb],
    [0.78 * w, yb],
    [0.955 * w, yb + 0.07],
    [0.99 * w, yb + 0.55 * (ybe - yb)],
    [w, ybe - 0.06],
    [0.95 * w, ybe],
    [lerp(0.95 * w, wr, 0.62), ybe + 0.58 * h],
    [wr, yt - 0.045 * g - 0.012],
    [0.5 * wr, yt - 0.006],
    [0, yt],
  ];
  // Closed loop: right side up, then the left side down (mirrored), without repeating the centres.
  const loop: THREE.Vector3[] = [
    ...half.map(([z, y]) => new THREE.Vector3(x, y, z)),
    ...half
      .slice(1, -1)
      .reverse()
      .map(([z, y]) => new THREE.Vector3(x, y, -z)),
  ];
  const curve = new THREE.CatmullRomCurve3(loop, true, "centripetal");
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < RING; i++) points.push(curve.getPoint(i / RING));
  return { x, glass: g, points };
}

export interface BodyGrid {
  positions: Float32Array;
  normals: Float32Array;
  /** Per station: how much greenhouse it has (0–1). */
  glass: number[];
  stationX: number[];
  /** Per quad (i * RING + j): 1 where the wheel arch is cut out. */
  cut: Uint8Array;
}

/** Station positions, denser at the ends where the nose and tail curve fast. */
function stationXs(): number[] {
  const xs: number[] = [];
  for (let i = 0; i < STATIONS; i++) {
    const u = i / (STATIONS - 1);
    const s = 0.5 - 0.5 * Math.cos(Math.PI * u); // 0…1, dense at both ends
    const mix = 0.55 * s + 0.45 * u;
    xs.push(G60.rearX + G60.length * mix);
  }
  return xs;
}

export function buildBodyGrid(): BodyGrid {
  const stationX = stationXs();
  const positions = new Float32Array(STATIONS * RING * 3);
  const glass: number[] = [];
  stationX.forEach((x, i) => {
    const s = section(x);
    glass.push(s.glass);
    s.points.forEach((p, j) => {
      const o = (i * RING + j) * 3;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = p.z;
    });
  });
  const cut = cutWheelArches(positions);
  const all = new THREE.BufferGeometry();
  all.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  all.setIndex(gridIndex((i, j) => !cut[i * RING + j]));
  all.computeVertexNormals();
  const normals = all.getAttribute("normal").array as Float32Array;
  all.dispose();
  return { positions, normals, glass, stationX, cut };
}

/**
 * Marks the quads inside the wheel arches, then moves the vertices on the edge of the cut onto the
 * arch circle, so the opening is a clean arc instead of a staircase of quads.
 */
function cutWheelArches(positions: Float32Array): Uint8Array {
  const cut = new Uint8Array(STATIONS * RING);
  const at = (v: number) =>
    [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!] as const;
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < RING; j++) {
      const ids = [vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)];
      let x = 0;
      let y = 0;
      let z = 0;
      for (const v of ids) {
        const p = at(v);
        x += p[0] / 4;
        y += p[1] / 4;
        z += p[2] / 4;
      }
      if (inWheelArch({ x, y, z, seg: segmentOf(j) })) cut[i * RING + j] = 1;
    }
  }
  const isCut = (i: number, j: number) =>
    i >= 0 && i < STATIONS - 1 ? cut[i * RING + ((j + RING) % RING)] === 1 : false;
  const isKept = (i: number, j: number) =>
    i >= 0 && i < STATIONS - 1 ? cut[i * RING + ((j + RING) % RING)] === 0 : false;
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < RING; j++) {
      const around: [number, number][] = [
        [i - 1, j - 1],
        [i - 1, j],
        [i, j - 1],
        [i, j],
      ];
      if (!around.some(([a, b]) => isCut(a, b)) || !around.some(([a, b]) => isKept(a, b))) continue;
      const v = vid(i, j) * 3;
      const x = positions[v]!;
      const y = positions[v + 1]!;
      const axle = AXLES.reduce((best, ax) => (Math.abs(x - ax) < Math.abs(x - best) ? ax : best));
      const dx = x - axle;
      const dy = y - WHEEL_Y;
      const d = Math.hypot(dx, dy);
      // The opening ends at the sill. Pulling the inner floor onto the circle creates
      // folded fins below the car and makes the underbody poke through the apron.
      if (d < 1e-6 || Math.abs(positions[v + 2]!) < 0.55 || segmentOf(j) === 0) continue;
      if (dy >= 0) {
        // Keep station x ordering across the crown of the arch. Radially moving
        // both coordinates can fold adjacent triangles into little saw teeth.
        const archX = Math.max(-G60.archRadius, Math.min(G60.archRadius, dx));
        positions[v] = axle + archX;
        positions[v + 1] = WHEEL_Y + Math.sqrt(Math.max(0, G60.archRadius ** 2 - archX ** 2));
      } else {
        // Below the hub, keep the sill height and move only towards the side of
        // the opening; the floor remains above the ground.
        const archY = Math.max(-G60.archRadius, dy);
        positions[v] =
          axle + Math.sign(dx) * Math.sqrt(Math.max(0, G60.archRadius ** 2 - archY ** 2));
      }
    }
  }
  return cut;
}

export interface Quad {
  i: number;
  j: number;
  /** Centre of the quad. */
  x: number;
  y: number;
  z: number;
  /** Cross-section segment (see segmentOf). */
  seg: number;
  /** Greenhouse amount at this station. */
  glass: number;
  /** Inside a wheel arch opening. */
  cut: boolean;
  /** Outward normal at the centre. */
  nx: number;
  ny: number;
  nz: number;
}

const vid = (i: number, j: number) => i * RING + (j % RING);

/** Triangle indices of every quad the predicate keeps. Normals face outward. */
function gridIndex(keep: (i: number, j: number) => boolean): number[] {
  const index: number[] = [];
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < RING; j++) {
      if (!keep(i, j)) continue;
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i + 1, j + 1);
      const d = vid(i, j + 1);
      index.push(a, b, d, b, c, d);
    }
  }
  return index;
}

export function quadAt(grid: BodyGrid, i: number, j: number): Quad {
  const ids = [vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)];
  let x = 0;
  let y = 0;
  let z = 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (const v of ids) {
    x += grid.positions[v * 3]!;
    y += grid.positions[v * 3 + 1]!;
    z += grid.positions[v * 3 + 2]!;
    nx += grid.normals[v * 3]!;
    ny += grid.normals[v * 3 + 1]!;
    nz += grid.normals[v * 3 + 2]!;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return {
    i,
    j,
    x: x / 4,
    y: y / 4,
    z: z / 4,
    seg: segmentOf(j),
    glass: Math.max(grid.glass[i]!, grid.glass[i + 1]!),
    cut: grid.cut[i * RING + j] === 1,
    nx: nx / len,
    ny: ny / len,
    nz: nz / len,
  };
}

/** One geometry per key, sharing the grid's vertices (optionally pushed out along the normals). */
export function panelGeometries(
  grid: BodyGrid,
  assign: (q: Quad) => string | null,
  offset = 0,
): Map<string, THREE.BufferGeometry> {
  const buckets = new Map<string, boolean[]>();
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < RING; j++) {
      const key = assign(quadAt(grid, i, j));
      if (key === null) continue;
      let mask = buckets.get(key);
      if (!mask) {
        mask = new Array<boolean>(STATIONS * RING).fill(false);
        buckets.set(key, mask);
      }
      mask[i * RING + j] = true;
    }
  }
  let positions = grid.positions;
  if (offset !== 0) {
    positions = new Float32Array(grid.positions.length);
    for (let k = 0; k < positions.length; k++) {
      positions[k] = grid.positions[k]! + grid.normals[k]! * offset;
    }
  }
  const out = new Map<string, THREE.BufferGeometry>();
  for (const [key, mask] of buckets) {
    // Keep only vertices this panel actually uses. Shared full-body attributes gave
    // every small panel the bounds of the entire car and wasted GPU buffers.
    const sourceIndex = gridIndex((i, j) => mask[i * RING + j]!);
    const remap = new Map<number, number>();
    const panelPositions: number[] = [];
    const panelNormals: number[] = [];
    const index = sourceIndex.map((v) => {
      let id = remap.get(v);
      if (id === undefined) {
        id = remap.size;
        remap.set(v, id);
        for (let k = 0; k < 3; k++) {
          panelPositions.push(positions[v * 3 + k]!);
          panelNormals.push(grid.normals[v * 3 + k]!);
        }
      }
      return id;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(panelPositions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(panelNormals, 3));
    geo.setIndex(index);
    geo.userData.openSurface = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    out.set(key, geo);
  }
  return out;
}

/** A line along one ring index (e.g. the shoulder), only where `keep` holds; for sketch lines. */
export function featureLine(
  grid: BodyGrid,
  ringIndex: number,
  keep: (x: number, y: number) => boolean,
): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < STATIONS - 1; i++) {
    const a = vid(i, ringIndex) * 3;
    const b = vid(i + 1, ringIndex) * 3;
    const p = grid.positions;
    if (!keep(p[a]!, p[a + 1]!) || !keep(p[b]!, p[b + 1]!)) continue;
    for (const v of [a, b]) {
      for (let k = 0; k < 3; k++) pts.push(p[v + k]! + grid.normals[v + k]! * 0.002);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/* ------------------------------------------------------------------------------------------ */
/* Which panel a quad belongs to                                                                */
/* ------------------------------------------------------------------------------------------ */

const AXLES = [G60.frontAxleX, G60.rearAxleX];
const WHEEL_Y = G60.tyreRadius;

export function inWheelArch(q: Pick<Quad, "x" | "y" | "z" | "seg">): boolean {
  if (q.seg === 0 && Math.abs(q.z) < 0.55) return false;
  if (q.seg > 4) return false;
  return AXLES.some((ax) => (q.x - ax) ** 2 + (q.y - WHEEL_Y) ** 2 < G60.archRadius ** 2);
}

/** Side window outline: front edge follows the A-pillar, rear edge the C-pillar, gap = B-pillar. */
const windowFront = (y: number) => 0.8 - (y - 1.0) * 1.82 - 0.13;
// The return at the foot of the C-pillar is BMW's characteristic Hofmeister kink.
const windowRear = (y: number) =>
  y < 1.12 ? lerp(-1.48, -1.66, smoothstep(1.05, 1.12, y)) : -1.66 + (y - 1.12) * 1.08;
const inBPillar = (x: number) => x > -0.31 && x < -0.19;
// The rear door's moving glass ends at an upright support in front of the small fixed quarter
// pane. Like the B-pillar it runs straight from the belt to the roof, and it stands right over the
// rear door handle (x = -1.17 in buildCar), as on the BMW M5.
export const REAR_WINDOW_SUPPORT_X = -1.17;
const inQuarterWindowFrame = (x: number) => Math.abs(x - REAR_WINDOW_SUPPORT_X) < 0.04;

function inSideWindow(q: Quad): boolean {
  return (
    q.x < windowFront(q.y) &&
    q.x > windowRear(q.y) &&
    !inBPillar(q.x) &&
    !inQuarterWindowFrame(q.x) &&
    q.seg <= 6 &&
    q.glass > 0.08
  );
}

/**
 * Panel key for one quad: a part id, optionally with ":glass" for glazing. null = no surface
 * (wheel arch openings).
 */
export function bodyPanel(q: Quad): string | null {
  const az = Math.abs(q.z);
  if (q.cut) return null;
  if (q.seg === 0) return "underbody";

  if (q.seg <= 4) {
    if (q.x > 1.91) return "front_bumper";
    if (q.x < -2.03) {
      // The boot lid wraps down the rear face around the plate. Its lower edge
      // curves up at the corners, giving the lid a readable outline above the bumper.
      const lidBottom = 0.69 + 0.13 * (az / 0.72) ** 4;
      if (q.x < -2.25 && az < 0.72 && q.y > lidBottom) return "trunk_lid";
      return q.y < 0.93 ? "rear_bumper" : az < 0.8 ? "trunk_lid" : "body";
    }
    // Dark sill trim between the wheels makes the body read lower, like on the real car.
    if (q.seg === 1 && q.x < 1.12 && q.x > -0.96) return "body:dark";
    if (q.seg >= 2) {
      if (q.x <= 0.86 && q.x >= -0.22) return "front_doors";
      if (q.x < -0.22 && q.x >= -1.3) return "rear_doors";
    }
    return "body";
  }

  // Top of the car: bonnet, windscreen, roof, rear window, boot lid.
  if (q.x > 0.86) return "hood";
  if (q.x < -1.97) return "trunk_lid";
  const belt = beltLine(q.x);
  const sideGlass = q.seg === 5 || q.seg === 6;
  // Chrome strip along the window line, under the side windows.
  if (sideGlass && q.y < belt + 0.022 && q.x < windowFront(belt) && q.x > windowRear(belt))
    return "side_windows:chrome";
  // Below the window line: the cowl in front of the windscreen, the deck behind the rear window.
  if (q.y < belt + 0.02) return "body";
  if (sideGlass && inSideWindow(q)) return "side_windows:glass";
  if (sideGlass && (inBPillar(q.x) || inQuarterWindowFrame(q.x))) return "roof:dark";
  if (q.seg >= 7 && az < 0.6) {
    if (q.x > 0.02) return "windshield:glass";
    // The taller reference deck no longer closes the rear glass at the belt line.
    // Inset it explicitly, retaining the old sketch's C-pillars and lower support.
    if (q.x < -1.28) {
      const glassHalfWidth = lerp(0.5, 0.6, smoothstep(-1.28, -1.82, q.x));
      return q.x > -1.82 && az < glassHalfWidth ? "rear_window:glass" : "roof";
    }
    if (az < 0.47 && q.x < -0.18 && q.x > -0.92) return "roof:glass";
  }
  return "roof";
}

/**
 * Panel edges follow the grid, so a slanted edge (A-pillar, window line) comes out as a staircase.
 * This relaxes every edge between two panels along its own chain, turning the steps into a smooth
 * line. Corners where three panels meet stay where they are.
 */
export function smoothPanelEdges(grid: BodyGrid, assign: (q: Quad) => string | null, passes = 8) {
  const keys: (string | null)[] = new Array(STATIONS * RING).fill(null);
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < RING; j++) keys[i * RING + j] = assign(quadAt(grid, i, j));
  }
  const key = (i: number, j: number) =>
    i < 0 || i >= STATIONS - 1 ? undefined : keys[i * RING + ((j + RING) % RING)];
  // Neighbours along panel edges, per vertex.
  const links = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  };
  const differ = (a: string | null | undefined, b: string | null | undefined) =>
    a != null && b != null && a !== b;
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < RING; j++) {
      // Edge (i, j) → (i + 1, j) separates quads (i, j − 1) and (i, j).
      if (i < STATIONS - 1 && differ(key(i, j - 1), key(i, j))) link(vid(i, j), vid(i + 1, j));
      // Edge (i, j) → (i, j + 1) separates quads (i − 1, j) and (i, j).
      if (differ(key(i - 1, j), key(i, j))) link(vid(i, j), vid(i, j + 1));
    }
  }
  const p = grid.positions;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Map<number, [number, number, number]>();
    for (const [v, ns] of links) {
      if (ns.size !== 2) continue;
      const [a, b] = [...ns] as [number, number];
      next.set(v, [
        0.5 * p[v * 3]! + 0.25 * (p[a * 3]! + p[b * 3]!),
        0.5 * p[v * 3 + 1]! + 0.25 * (p[a * 3 + 1]! + p[b * 3 + 1]!),
        0.5 * p[v * 3 + 2]! + 0.25 * (p[a * 3 + 2]! + p[b * 3 + 2]!),
      ]);
    }
    for (const [v, [x, y, z]] of next) {
      p[v * 3] = x;
      p[v * 3 + 1] = y;
      p[v * 3 + 2] = z;
    }
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.BufferAttribute(p, 3));
  surface.setIndex(gridIndex((i, j) => !grid.cut[i * RING + j]));
  surface.computeVertexNormals();
  grid.normals = surface.getAttribute("normal").array as Float32Array;
  surface.dispose();
}
