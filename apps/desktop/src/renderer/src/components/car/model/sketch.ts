import * as THREE from "three";
import type { CarPiece, PieceKind } from "./buildCar";

/**
 * The sketch look: a pen drawing, not a rendering. Every surface is filled with the page colour
 * (so it hides the lines behind it) and drawn with ink: silhouettes, panel lines and creases.
 * Only the selected part gets a soft blue fill. Glass masks the cabin in exterior view; the interior
 * view reveals all cabin parts through the ghosted body. Unselected volumes have no fill.
 * Colours come from the app's CSS tokens, so it follows light and dark mode.
 */

export interface SketchPalette {
  background: THREE.Color;
  ink: THREE.Color;
  brand: THREE.Color;
  selection: THREE.Color;
}

export function readPalette(): SketchPalette {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    new THREE.Color(css.getPropertyValue(name).trim() || fallback);
  return {
    background: token("--color-panel", "#ffffff"),
    ink: token("--color-ink", "#111214"),
    brand: token("--color-brand", "#16588e"),
    selection: token("--color-brand-soft", "#e6f0f9"),
  };
}

/** See-through kinds: drawn with lines only. */
const SEE_THROUGH: ReadonlySet<PieceKind> = new Set(["volume", "glow"]);

/** Kinds that get an ink silhouette (inverted hull). Thin and see-through ones don't. */
export const OUTLINED: ReadonlySet<PieceKind> = new Set([
  "paint",
  "dark",
  "chrome",
  "tyre",
  "rim",
  "metal",
  "accent",
  "trim",
  "seat",
]);

export type PartState = "idle" | "hasRequirements" | "hover" | "selected";

export interface PieceStyle {
  fill: THREE.MeshBasicMaterial;
  lines: THREE.LineBasicMaterial;
}

export function createPieceStyle(piece: CarPiece, p: SketchPalette): PieceStyle {
  const opacity = SEE_THROUGH.has(piece.kind) ? 0 : 1;
  const fill = new THREE.MeshBasicMaterial({
    color: p.background,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: opacity >= 1,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  fill.userData.base = { opacity };
  const lines = new THREE.LineBasicMaterial({ color: p.ink, transparent: true, opacity: 0.7 });
  return { fill, lines };
}

/** Applies the part state and view mode to one piece. Returns whether it can be clicked. */
export function applyState(
  piece: CarPiece,
  style: PieceStyle,
  state: PartState,
  ghost: boolean,
  p: SketchPalette,
): boolean {
  const base = style.fill.userData.base as { opacity: number };
  const active = state === "hover" || state === "selected";
  const color = p.background.clone();
  if (piece.kind === "glass") color.lerp(p.ink, 0.045);
  let opacity = base.opacity;
  // Selection is the only colour on the drawing: brand-coloured lines and a faint wash.
  if (state === "selected") {
    color.copy(p.selection);
    opacity = Math.max(opacity, 0.5);
  }
  let lineOpacity = piece.layer === "interior" ? 0.55 : 0.75;
  if (active) lineOpacity = 1;
  if (ghost) {
    opacity = state === "selected" ? 0.15 : 0;
    lineOpacity = active ? 0.8 : 0.14;
  }
  style.fill.color.copy(color);
  style.fill.opacity = opacity;
  const transparent = opacity < 1;
  if (style.fill.transparent !== transparent) {
    style.fill.transparent = transparent;
    style.fill.needsUpdate = true;
  }
  style.fill.depthWrite = opacity >= 1;
  style.lines.color.copy(active ? p.brand : p.ink);
  style.lines.opacity = piece.kind === "liner" ? 0 : lineOpacity;
  return !ghost && piece.partId !== null;
}

/** Ink silhouette: back faces pushed out by a constant number of pixels. */
export function createOutlineMaterial(color: THREE.Color, widthPx: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      color: { value: color.clone() },
      width: { value: widthPx },
      resolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float width;
      uniform vec2 resolution;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vec4 clipN = projectionMatrix * vec4(n, 0.0);
        vec2 dir = length(clipN.xy) > 1e-5 ? normalize(clipN.xy) : vec2(0.0);
        clip.xy += dir * width * 2.0 / resolution * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      void main() { gl_FragColor = vec4(color, 1.0); }
    `,
  });
}
