import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { CarPiece, PieceKind, PieceLayer } from "./buildCar";
import {
  applyState,
  createOutlineMaterial,
  createPieceStyle,
  GHOST_LINE_OPACITY,
  GHOST_SKETCH_RATIO,
  readPalette,
  type SketchPalette,
} from "./sketch";

const palettes: Record<string, SketchPalette> = {
  light: {
    background: new THREE.Color("#ffffff"),
    ink: new THREE.Color("#111214"),
    brand: new THREE.Color("#16588e"),
    selection: new THREE.Color("#e6f0f9"),
  },
  dark: {
    background: new THREE.Color("#121315"),
    ink: new THREE.Color("#f1f3f5"),
    brand: new THREE.Color("#81c4ff"),
    selection: new THREE.Color("#132638"),
  },
};

const disposables: { dispose: () => void }[] = [];

function setup(palette: SketchPalette, kind: PieceKind = "paint", layer: PieceLayer = "exterior") {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const piece: CarPiece = { mesh, partId: "front_doors", kind, layer };
  const style = createPieceStyle(piece, palette);
  disposables.push(mesh.geometry, mesh.material, style.fill, style.lines);
  return { piece, style };
}

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  vi.unstubAllGlobals();
});

describe.each(Object.entries(palettes))("car selection in %s mode", (_theme, palette) => {
  it("fills the selected part with soft blue while keeping opaque sketch surfaces and blue lines", () => {
    const { piece, style } = setup(palette);

    expect(applyState(piece, style, "selected", 1, palette)).toBe(true);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.color.equals(palette.background)).toBe(false);
    expect(style.fill.opacity).toBe(1);
    expect(style.fill.transparent).toBe(false);
    expect(style.fill.depthWrite).toBe(true);
    expect(style.lines.color.equals(palette.brand)).toBe(true);
    expect(style.lines.opacity).toBe(1);
  });

  it.each(["idle", "hover", "hasRequirements"] as const)(
    "removes the blue fill when the part becomes %s",
    (state) => {
      const { piece, style } = setup(palette);
      applyState(piece, style, "selected", 1, palette);
      applyState(piece, style, state, 1, palette);

      expect(style.fill.color.equals(palette.background)).toBe(true);
      expect(style.lines.color.equals(state === "hover" ? palette.brand : palette.ink)).toBe(true);
    },
  );

  it("highlights interior parts without tinting other pieces", () => {
    const selected = setup(palette, "seat", "interior");
    const other = setup(palette, "seat", "interior");
    applyState(selected.piece, selected.style, "selected", 1, palette);
    applyState(other.piece, other.style, "idle", 1, palette);

    expect(selected.style.fill.color.equals(palette.selection)).toBe(true);
    expect(other.style.fill.color.equals(palette.background)).toBe(true);
  });

  it("preserves the glass mask and restores its normal fill after deselection", () => {
    const { piece, style } = setup(palette, "glass");
    applyState(piece, style, "selected", 1, palette);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.depthWrite).toBe(true);

    applyState(piece, style, "idle", 1, palette);
    expect(style.fill.color.equals(palette.background.clone().lerp(palette.ink, 0.045))).toBe(true);
  });

  it("fades exterior fills in place, retaining faint grey lines and allowing cabin picks", () => {
    const { piece, style } = setup(palette);
    expect(applyState(piece, style, "selected", 0.15, palette)).toBe(false);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.opacity).toBe(0.15);
    expect(style.fill.transparent).toBe(true);
    expect(style.fill.depthWrite).toBe(false);

    applyState(piece, style, "idle", 0, palette);
    expect(style.fill.opacity).toBe(0);
    expect(style.lines.opacity).toBe(0.14);
    expect(style.lines.color.equals(palette.ink)).toBe(true);
    expect(piece.mesh.visible).toBe(true);
    applyState(piece, style, "idle", 1, palette);
    expect(style.fill.color.equals(palette.background)).toBe(true);
    expect(style.fill.transparent).toBe(false);
    expect(style.fill.depthWrite).toBe(true);
  });

  it.each(["idle", "hover", "hasRequirements", "selected"] as const)(
    "keeps ghosted %s exterior lines grey, visible and non-interactive",
    (state) => {
      const { piece, style } = setup(palette);
      expect(applyState(piece, style, state, 0, palette)).toBe(false);
      expect(style.fill.opacity).toBe(0);
      expect(style.fill.depthWrite).toBe(false);
      expect(style.lines.opacity).toBe(GHOST_LINE_OPACITY);
      expect(style.lines.color.equals(palette.ink)).toBe(true);
    },
  );

  it.each(["paint", "glass", "tyre", "rim", "metal", "dark"] as const)(
    "retains the assembled %s outline instead of hiding the exterior piece",
    (kind) => {
      const { piece, style } = setup(palette, kind);
      expect(applyState(piece, style, "idle", 0, palette)).toBe(false);
      expect(style.fill.opacity).toBe(0);
      expect(style.lines.opacity).toBe(0.14);
      expect(piece.mesh.visible).toBe(true);
    },
  );

  it("interpolates line opacity continuously and avoids recompiling each fade frame", () => {
    const { piece, style } = setup(palette);
    applyState(piece, style, "idle", 0.5, palette);
    expect(style.fill.opacity).toBe(0.5);
    expect(style.lines.opacity).toBeCloseTo((0.75 + 0.14) / 2);
    const version = style.fill.version;
    applyState(piece, style, "idle", 0.25, palette);
    expect(style.fill.version).toBe(version);
    expect(style.lines.opacity).toBeGreaterThan(0.14);
    expect(style.lines.opacity).toBeLessThan((0.75 + 0.14) / 2);
  });

  it("never fades or disables the assembled cabin when the exterior is ghosted", () => {
    const { piece, style } = setup(palette, "seat", "interior");
    expect(applyState(piece, style, "idle", 1, palette)).toBe(true);
    expect(style.fill.opacity).toBe(1);
    expect(style.lines.opacity).toBe(0.55);
  });

  it("removes wheel-well shielding without adding ghost liner edges", () => {
    const { piece, style } = setup(palette, "liner");
    piece.partId = null;
    expect(applyState(piece, style, "idle", 0, palette)).toBe(false);
    expect(style.fill.opacity).toBe(0);
    expect(style.fill.depthWrite).toBe(false);
    expect(style.lines.opacity).toBe(0);
  });

  it("only shows the fill of a see-through volume while selected", () => {
    const { piece, style } = setup(palette, "volume", "interior");
    applyState(piece, style, "selected", 1, palette);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.opacity).toBe(0.5);
    expect(style.fill.depthWrite).toBe(false);

    applyState(piece, style, "idle", 1, palette);
    expect(style.fill.opacity).toBe(0);
  });
});

describe("grey-line sketch silhouettes", () => {
  it("preserves the original faint character-line endpoint", () => {
    expect(0.35 * GHOST_SKETCH_RATIO).toBeCloseTo(0.08);
  });

  it("allows exterior silhouettes to fade without hiding or fading cabin outlines", () => {
    const exterior = createOutlineMaterial(palettes.light!.ink, 1.4);
    const interior = createOutlineMaterial(palettes.light!.ink, 1.4);
    disposables.push(exterior, interior);
    expect(exterior.transparent).toBe(true);
    expect(exterior.depthWrite).toBe(false);
    exterior.uniforms.opacity!.value = 0.5;
    expect(interior.uniforms.opacity!.value).toBe(1);
    expect(exterior.fragmentShader).toContain("vec4(color, opacity)");
  });
});

describe("readPalette", () => {
  it("reads the selection colour from the app theme", () => {
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (name: string) => (name === "--color-brand-soft" ? " #132638 " : ""),
    }));

    expect(readPalette().selection.equals(palettes.dark!.selection)).toBe(true);
  });

  it("falls back to a soft blue when the theme token is missing", () => {
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));

    expect(readPalette().selection.equals(palettes.light!.selection)).toBe(true);
  });
});
