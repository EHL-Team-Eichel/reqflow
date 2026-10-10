import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { CarPiece, PieceKind, PieceLayer } from "./buildCar";
import { applyState, createPieceStyle, readPalette, type SketchPalette } from "./sketch";

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

    expect(applyState(piece, style, "selected", false, palette)).toBe(true);
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
      applyState(piece, style, "selected", false, palette);
      applyState(piece, style, state, false, palette);

      expect(style.fill.color.equals(palette.background)).toBe(true);
      expect(style.lines.color.equals(state === "hover" ? palette.brand : palette.ink)).toBe(true);
    },
  );

  it("highlights interior parts without tinting other pieces", () => {
    const selected = setup(palette, "seat", "interior");
    const other = setup(palette, "seat", "interior");
    applyState(selected.piece, selected.style, "selected", false, palette);
    applyState(other.piece, other.style, "idle", false, palette);

    expect(selected.style.fill.color.equals(palette.selection)).toBe(true);
    expect(other.style.fill.color.equals(palette.background)).toBe(true);
  });

  it("preserves the glass mask and restores its normal fill after deselection", () => {
    const { piece, style } = setup(palette, "glass");
    applyState(piece, style, "selected", false, palette);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.depthWrite).toBe(true);

    applyState(piece, style, "idle", false, palette);
    expect(style.fill.color.equals(palette.background.clone().lerp(palette.ink, 0.045))).toBe(true);
  });

  it("keeps ghosted exterior parts see-through and unpickable", () => {
    const { piece, style } = setup(palette);
    expect(applyState(piece, style, "selected", true, palette)).toBe(false);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.opacity).toBe(0.15);
    expect(style.fill.transparent).toBe(true);
    expect(style.fill.depthWrite).toBe(false);

    applyState(piece, style, "idle", true, palette);
    expect(style.fill.opacity).toBe(0);
    applyState(piece, style, "idle", false, palette);
    expect(style.fill.color.equals(palette.background)).toBe(true);
    expect(style.fill.transparent).toBe(false);
    expect(style.fill.depthWrite).toBe(true);
  });

  it("only shows the fill of a see-through volume while selected", () => {
    const { piece, style } = setup(palette, "volume", "interior");
    applyState(piece, style, "selected", false, palette);
    expect(style.fill.color.equals(palette.selection)).toBe(true);
    expect(style.fill.opacity).toBe(0.5);
    expect(style.fill.depthWrite).toBe(false);

    applyState(piece, style, "idle", false, palette);
    expect(style.fill.opacity).toBe(0);
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
