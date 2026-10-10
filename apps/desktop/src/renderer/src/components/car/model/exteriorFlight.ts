import * as THREE from "three";
import type { CarModel, CarPiece } from "./buildCar";

export type CarView = "exterior" | "interior";
export const VIEW_FLIGHT_MS = 850;

export interface PieceFlight {
  readonly home: THREE.Vector3;
  readonly offset: THREE.Vector3;
  readonly delay: number;
  amount: number;
  opacity: number;
}

/** A single reversible timeline: interrupted flights retrace exactly the same paths. */
export class ExteriorFlight {
  readonly pieces = new Map<CarPiece, PieceFlight>();
  /** The nearest mesh to each badge, including stationary interior meshes. */
  readonly badges = new Map<string, PieceFlight>();
  progress: number;
  private target: number;
  private lastTime = 0;
  private readonly root: THREE.Group;

  constructor(car: CarModel, view: CarView) {
    this.root = car.root;
    this.progress = this.target = view === "interior" ? 1 : 0;
    car.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(car.root);
    const center = bounds.getCenter(new THREE.Vector3());
    const halfSize = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const centers = new Map<CarPiece, THREE.Vector3>();
    for (const piece of car.pieces) {
      const at = new THREE.Box3().setFromObject(piece.mesh).getCenter(new THREE.Vector3());
      centers.set(piece, at);
      if (piece.layer !== "exterior") continue;
      const radial = at.clone().sub(center);
      radial.set(
        radial.x / Math.max(halfSize.x, 0.01),
        radial.y / Math.max(halfSize.y, 0.01),
        radial.z / Math.max(halfSize.z, 0.01),
      );
      // Roof/bonnet lift, underfloor drops, side pieces spread sideways, ends move outwards.
      const offset = radial.clone().multiply(new THREE.Vector3(1.1, 0.9, 1.8));
      if (offset.lengthSq() < 0.01) offset.set(0, 1, 0);
      offset.normalize().multiplyScalar(3.8);
      this.pieces.set(piece, {
        home: piece.mesh.position.clone(),
        offset,
        delay: 0.14 * (1 - Math.min(1, Math.abs(radial.y))),
        amount: 0,
        opacity: 1,
      });
    }
    for (const [partId, anchor] of car.anchors) {
      let nearest: CarPiece | undefined;
      let distance = Infinity;
      for (const piece of car.pieces) {
        if (piece.partId !== partId) continue;
        const d = centers.get(piece)!.distanceToSquared(anchor);
        if (d < distance) {
          distance = d;
          nearest = piece;
        }
      }
      const flight = nearest && this.pieces.get(nearest);
      if (flight) this.badges.set(partId, flight);
    }
    this.apply();
  }

  get active(): boolean {
    return this.progress !== this.target;
  }

  setView(view: CarView, now: number, immediate = false): void {
    this.update(now);
    this.target = view === "interior" ? 1 : 0;
    this.lastTime = now;
    if (immediate) {
      this.progress = this.target;
      this.apply();
    }
  }

  /** Returns true only if meshes changed, so a settled viewer doesn't render continuously. */
  update(now: number): boolean {
    if (!this.active) return false;
    const step = Math.max(0, now - this.lastTime) / VIEW_FLIGHT_MS;
    this.lastTime = now;
    if (step === 0) return false;
    this.progress =
      this.target > this.progress
        ? Math.min(this.target, this.progress + step)
        : Math.max(this.target, this.progress - step);
    this.apply();
    return true;
  }

  private apply(): void {
    for (const [piece, flight] of this.pieces) {
      flight.amount = THREE.MathUtils.smoothstep(this.progress, flight.delay, 1);
      // Keep pieces solid while they separate; fade only near the end of their journey.
      flight.opacity = 1 - THREE.MathUtils.smoothstep(flight.amount, 0.55, 0.95);
      piece.mesh.position.copy(flight.home).addScaledVector(flight.offset, flight.amount);
      piece.mesh.visible = flight.opacity > 0;
    }
    this.root.updateMatrixWorld(true);
  }
}
