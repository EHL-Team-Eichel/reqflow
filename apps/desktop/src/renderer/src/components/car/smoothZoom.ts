import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

type ZoomLimits = Pick<OrbitControls, "target" | "minDistance" | "maxDistance">;
type WheelInput = Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">;

const ZOOM_PER_PIXEL = 0.001;
const ZOOM_RESPONSE_SECONDS = 0.075;
const SETTLE_THRESHOLD = 0.0001;

/** Normalize mouse wheels, high-resolution trackpads and trackpad pinch into bounded pixels. */
export function zoomWheelPixels(event: WheelInput, pageHeight: number): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  const pixels = event.deltaY * unit * (event.ctrlKey ? 10 : 1);
  return Number.isFinite(pixels) ? Math.max(-240, Math.min(240, pixels)) : 0;
}

/** OrbitControls damps angles, but not distance: ease zoom separately without changing its internals. */
export class SmoothZoom {
  private distance: number | null = null;
  private direction = 0;
  private readonly offset = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly controls: ZoomLimits,
  ) {}

  get active(): boolean {
    return this.distance !== null;
  }

  queue(event: WheelInput, pageHeight: number): boolean {
    const pixels = zoomWheelPixels(event, pageHeight);
    if (pixels === 0) return false;
    const current = this.camera.position.distanceTo(this.controls.target);
    const direction = Math.sign(pixels);
    // Reversing a gesture must reverse immediately, not first consume the old eased remainder.
    const base = this.direction !== direction ? current : (this.distance ?? current);
    this.direction = direction;
    this.distance = this.clamp(base * Math.exp(pixels * ZOOM_PER_PIXEL));
    return true;
  }

  reset(): void {
    this.distance = null;
    this.direction = 0;
  }

  /** Exponential easing in log-distance gives the same response at any zoom level or frame rate. */
  update(deltaSeconds: number, reducedMotion = false): boolean {
    if (this.distance === null) return false;
    const current = this.camera.position.distanceTo(this.controls.target);
    if (current === 0) {
      this.reset();
      return false;
    }
    const target = this.clamp(this.distance);
    const error = Math.log(target / current);
    const elapsed = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const amount = reducedMotion ? 1 : 1 - Math.exp(-elapsed / ZOOM_RESPONSE_SECONDS);
    let next = this.clamp(current * Math.exp(error * amount));
    if (reducedMotion || Math.abs(Math.log(target / next)) < SETTLE_THRESHOLD) {
      next = target;
      this.reset();
    }
    if (next === current) return false;
    this.offset
      .copy(this.camera.position)
      .sub(this.controls.target)
      .multiplyScalar(next / current);
    this.camera.position.copy(this.controls.target).add(this.offset);
    return true;
  }

  private clamp(distance: number): number {
    return Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, distance));
  }
}

/** Capture only canvas wheel input, so OrbitControls cannot also apply its immediate zoom step. */
export function bindSmoothZoom(
  element: HTMLElement,
  zoom: SmoothZoom,
  controls: Pick<OrbitControls, "enabled" | "enableZoom">,
  onZoomStart: () => void,
): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!controls.enabled || !controls.enableZoom || !zoom.queue(event, element.clientHeight))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onZoomStart();
  };
  element.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    element.removeEventListener("wheel", onWheel, { capture: true });
    zoom.reset();
  };
}
