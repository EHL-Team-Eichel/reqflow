export const IDLE_ORBIT_DELAY_MS = 30_000;

/** App-wide activity, not just canvas input. Opening the car starts in idle mode. */
export function trackIdleOrbit(target: EventTarget, now: () => number = () => performance.now()) {
  let lastActivity = -Infinity;
  const pointers = new Set<number>();
  const activity = () => {
    lastActivity = now();
  };
  const down = (event: Event) => {
    pointers.add((event as PointerEvent).pointerId);
    activity();
  };
  const up = (event: Event) => {
    pointers.delete((event as PointerEvent).pointerId);
    activity();
  };
  const blur = () => {
    pointers.clear();
  };
  const listeners: [string, EventListener][] = [
    ["pointermove", activity],
    ["pointerdown", down],
    ["pointerup", up],
    ["pointercancel", up],
    ["wheel", activity],
    ["keydown", activity],
    ["scroll", activity],
    ["blur", blur],
  ];
  for (const [type, listener] of listeners)
    target.addEventListener(type, listener, { capture: true, passive: true });
  return {
    shouldRotate: () => pointers.size === 0 && now() - lastActivity >= IDLE_ORBIT_DELAY_MS,
    dispose: () => {
      for (const [type, listener] of listeners)
        target.removeEventListener(type, listener, { capture: true });
    },
  };
}
