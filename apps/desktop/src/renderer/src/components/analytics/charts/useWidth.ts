import { useLayoutEffect, useRef, useState } from "react";

/**
 * Width of a chart container in CSS pixels, kept current with a ResizeObserver, so SVG charts
 * draw at their real size (crisp 2px lines, readable labels) instead of being scaled.
 */
export function useWidth<T extends HTMLElement = HTMLDivElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.floor(w)); // same value → React skips the render
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}
