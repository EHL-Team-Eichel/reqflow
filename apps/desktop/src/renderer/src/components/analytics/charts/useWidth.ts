import { useLayoutEffect, useRef, useState } from "react";

/**
 * Width of a chart container in CSS pixels, kept current with a ResizeObserver, so SVG charts
 * draw at their real size (crisp 2px lines, readable labels) instead of being scaled. Updates
 * wait for the next frame: a chart that changes its own height in response would otherwise
 * re-trigger the observer within the same frame ("ResizeObserver loop" errors).
 */
export function useWidth<T extends HTMLElement = HTMLDivElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (!w) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(Math.floor(w))); // same value → no render
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fallback]);
  return [ref, width] as const;
}
