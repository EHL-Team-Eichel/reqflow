import { MathUtils } from "three";

export type CarView = "exterior" | "interior";
export const VIEW_FADE_MS = 850;
export const SILHOUETTE_FADE_END = 0.12;

/**
 * Human-selected grey-line transition (2026-10-11): fade in place, never explode the car.
 * Restore the faint-outline look from f95ba3d using the reversible timeline from 5accfdf.
 * Deliberately owns no meshes/transforms: geometry and badge anchors must remain assembled.
 */
export class ExteriorFade {
  progress: number;
  private target: number;
  private lastTime = 0;

  constructor(view: CarView) {
    this.progress = this.target = view === "interior" ? 1 : 0;
  }

  get active(): boolean {
    return this.progress !== this.target;
  }

  /** Opaque exterior at 1; transparent fills with faint grey lines at 0. */
  get visibility(): number {
    // Fade inverted-hull outlines while opaque fills still mask their back faces.
    // Otherwise transparent body panels expose those back faces as solid ink blocks.
    return 1 - MathUtils.smoothstep(this.progress, SILHOUETTE_FADE_END, 1);
  }

  get silhouetteVisibility(): number {
    return 1 - MathUtils.smoothstep(this.progress, 0, SILHOUETTE_FADE_END);
  }

  setView(view: CarView, now: number, immediate = false): void {
    this.update(now);
    this.target = view === "interior" ? 1 : 0;
    this.lastTime = now;
    if (immediate) this.progress = this.target;
  }

  /** A single reversible timeline; changing direction never jumps or restarts the full duration. */
  update(now: number): boolean {
    if (!this.active) return false;
    const step = Math.max(0, now - this.lastTime) / VIEW_FADE_MS;
    this.lastTime = now;
    if (step === 0) return false;
    this.progress =
      this.target > this.progress
        ? Math.min(this.target, this.progress + step)
        : Math.max(this.target, this.progress - step);
    return true;
  }
}
