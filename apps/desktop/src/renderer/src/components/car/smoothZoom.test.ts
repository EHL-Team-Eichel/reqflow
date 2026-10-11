import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { bindSmoothZoom, SmoothZoom, zoomWheelPixels } from "./smoothZoom";

function setup(distance = 8) {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, distance);
  const controls = {
    target: new Vector3(),
    minDistance: 2.2,
    maxDistance: 16,
    enabled: true,
    enableZoom: true,
  };
  const zoom = new SmoothZoom(camera, controls);
  const radius = () => camera.position.distanceTo(controls.target);
  const queue = (deltaY: number) => zoom.queue({ deltaY, deltaMode: 0, ctrlKey: false }, 600);
  const settle = () => {
    for (let frame = 0; frame < 120 && zoom.active; frame++) zoom.update(1 / 60);
    expect(zoom.active).toBe(false);
  };
  return { camera, controls, zoom, radius, queue, settle };
}

describe("zoom wheel normalization", () => {
  it.each([
    [48, 0, false, 48],
    [3, 1, false, 48],
    [0.08, 2, false, 48],
    [4.8, 0, true, 48],
    [-0.5, 0, false, -0.5],
    [-10000, 0, true, -240],
    [10000, 2, false, 240],
  ])("normalizes delta %s, mode %s, pinch %s", (deltaY, deltaMode, ctrlKey, expected) => {
    expect(zoomWheelPixels({ deltaY, deltaMode, ctrlKey }, 600)).toBeCloseTo(expected);
  });

  it.each([NaN, Infinity, -Infinity, 0])("ignores non-finite/empty input %s", (deltaY) => {
    const { zoom } = setup();
    expect(zoom.queue({ deltaY, deltaMode: 0, ctrlKey: false }, 600)).toBe(false);
    expect(zoom.active).toBe(false);
  });
});

describe("smooth car zoom", () => {
  it.each([-100, 100])(
    "eases delta %s across frames, without a handler jump or overshoot",
    (delta) => {
      const { queue, zoom, radius, settle } = setup();
      const target = 8 * Math.exp(delta * 0.001);
      queue(delta);
      expect(radius()).toBe(8);
      expect(zoom.update(1 / 60)).toBe(true);
      expect(radius()).toBeGreaterThan(Math.min(8, target));
      expect(radius()).toBeLessThan(Math.max(8, target));
      let previous = radius();
      for (let i = 0; i < 10; i++) {
        zoom.update(1 / 60);
        expect(Math.abs(radius() - target)).toBeLessThan(Math.abs(previous - target));
        previous = radius();
      }
      settle();
      expect(radius()).toBeCloseTo(target, 10);
      expect(zoom.update(1 / 60)).toBe(false);
    },
  );

  it("has the same response at 30, 60 and 144 Hz", () => {
    const radii = [30, 60, 144].map((fps) => {
      const { queue, zoom, radius } = setup();
      queue(-200);
      for (let i = 0; i < fps / 2; i++) zoom.update(1 / fps);
      return radius();
    });
    expect(radii[0]).toBeCloseTo(radii[1]!, 10);
    expect(radii[1]).toBeCloseTo(radii[2]!, 10);
  });

  it("accumulates fine trackpad packets without discarding distance between frames", () => {
    const coarse = setup();
    coarse.queue(-100);
    coarse.settle();
    const fine = setup();
    for (let i = 0; i < 100; i++) {
      fine.queue(-1);
      fine.zoom.update(1 / 144);
    }
    fine.settle();
    expect(fine.radius()).toBeCloseTo(coarse.radius(), 10);
  });

  it("reverses immediately even with a large pending zoom remainder", () => {
    const { queue, zoom, radius } = setup();
    queue(-240);
    zoom.update(1 / 60);
    const before = radius();
    queue(1);
    expect(radius()).toBe(before);
    zoom.update(1 / 60);
    expect(radius()).toBeGreaterThan(before);
  });

  it.each([-1, 1])(
    "clamps repeated scrolling at the %s distance limit and reverses without backlog",
    (sign) => {
      const { queue, zoom, radius, controls, settle } = setup();
      for (let i = 0; i < 100; i++) queue(sign * 240);
      for (let i = 0; i < 60; i++) {
        zoom.update(1 / 60);
        expect(radius()).toBeGreaterThanOrEqual(controls.minDistance);
        expect(radius()).toBeLessThanOrEqual(controls.maxDistance);
      }
      settle();
      const limit = sign === -1 ? controls.minDistance : controls.maxDistance;
      expect(radius()).toBeCloseTo(limit);
      queue(-sign);
      zoom.update(1 / 60);
      expect(sign * (radius() - limit)).toBeLessThan(0);
    },
  );

  it("honors a changed maximum distance while easing", () => {
    const { queue, zoom, controls, radius, settle } = setup();
    queue(240);
    controls.maxDistance = 8.1;
    zoom.update(1 / 60);
    expect(radius()).toBeLessThanOrEqual(8.1);
    settle();
    expect(radius()).toBeCloseTo(8.1);
  });

  it("keeps the orbit direction and panned target intact", () => {
    const { camera, controls, queue, zoom } = setup();
    controls.target.set(1, 0.7, -2);
    camera.position.set(6, 3, -7);
    const target = controls.target.clone();
    const direction = camera.position.clone().sub(target).normalize();
    queue(-100);
    zoom.update(1 / 60);
    expect(controls.target.equals(target)).toBe(true);
    expect(camera.position.clone().sub(target).normalize().distanceTo(direction)).toBeLessThan(
      1e-10,
    );
  });

  it("cancels pending zoom for dragging/presets and starts again at the new camera distance", () => {
    const { camera, queue, zoom, radius, settle } = setup();
    queue(-100);
    zoom.update(1 / 60);
    zoom.reset();
    const before = radius();
    expect(zoom.update(1 / 60)).toBe(false);
    expect(radius()).toBe(before);
    camera.position.set(0, 0, 10);
    queue(-100);
    settle();
    expect(radius()).toBeCloseTo(10 * Math.exp(-0.1));
  });

  it("snaps to the endpoint when reduced motion is enabled during easing", () => {
    const { queue, zoom, radius } = setup();
    queue(-100);
    zoom.update(1 / 60);
    expect(zoom.update(0, true)).toBe(true);
    expect(radius()).toBeCloseTo(8 * Math.exp(-0.1), 10);
    expect(zoom.active).toBe(false);
  });

  it.each([0, -1, NaN])("does not advance at invalid/zero elapsed time %s", (elapsed) => {
    const { queue, zoom, radius } = setup();
    queue(-100);
    expect(zoom.update(elapsed)).toBe(false);
    expect(radius()).toBe(8);
  });
});

function wheelEvent(deltaY = -100) {
  const event = new Event("wheel", { cancelable: true });
  Object.assign(event, { deltaY, deltaMode: 0, ctrlKey: false });
  return event;
}

describe("canvas wheel binding", () => {
  const element = () => Object.assign(new EventTarget(), { clientHeight: 600 }) as HTMLElement;

  it("queues once, prevents native immediate zoom, and does not move the camera in the handler", () => {
    const { zoom, controls, radius } = setup();
    const canvas = element();
    const start = vi.fn();
    const unbind = bindSmoothZoom(canvas, zoom, controls, start);
    const nativeZoom = vi.fn();
    canvas.addEventListener("wheel", nativeZoom);
    const event = wheelEvent();
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(nativeZoom).not.toHaveBeenCalled();
    expect(radius()).toBe(8);
    expect(zoom.active).toBe(true);
    unbind();
    expect(zoom.active).toBe(false);
    canvas.dispatchEvent(wheelEvent());
    expect(start).toHaveBeenCalledOnce();
    expect(nativeZoom).toHaveBeenCalledOnce();
  });

  it.each(["enabled", "enableZoom"] as const)("leaves input untouched when %s is false", (key) => {
    const { zoom, controls } = setup();
    controls[key] = false;
    const canvas = element();
    const start = vi.fn();
    const unbind = bindSmoothZoom(canvas, zoom, controls, start);
    const event = wheelEvent();
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(zoom.active).toBe(false);
    unbind();
  });

  it("leaves horizontal-only scrolling untouched", () => {
    const { zoom, controls } = setup();
    const canvas = element();
    const start = vi.fn();
    const unbind = bindSmoothZoom(canvas, zoom, controls, start);
    const event = wheelEvent(0);
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(start).not.toHaveBeenCalled();
    unbind();
  });
});
