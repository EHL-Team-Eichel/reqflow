import { describe, expect, it } from "vitest";
import { editorShortcut } from "./editor-shortcuts";

const event = (key: string, patch = {}) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
});

describe("graph keyboard shortcuts", () => {
  it("supports Windows/Linux and macOS editing conventions", () => {
    expect(editorShortcut(event("z"), false)).toBe("undo");
    expect(
      editorShortcut(event("Z", { shiftKey: true, metaKey: true, ctrlKey: false }), false),
    ).toBe("redo");
    expect(editorShortcut(event("y"), false)).toBe("redo");
    expect(editorShortcut(event("c"), false)).toBe("copy");
    expect(editorShortcut(event("v"), false)).toBe("paste");
    expect(editorShortcut(event("d"), false)).toBe("duplicate");
  });

  it("does not steal text editing, selected text, IME or unrelated shortcuts", () => {
    expect(editorShortcut(event("z"), true)).toBeNull();
    expect(editorShortcut(event("c"), false, true)).toBeNull();
    expect(editorShortcut(event("z", { isComposing: true }), false)).toBeNull();
    expect(editorShortcut(event("v", { altKey: true }), false)).toBeNull();
    expect(editorShortcut(event("v", { shiftKey: true }), false)).toBeNull();
    expect(editorShortcut(event("s"), false)).toBeNull();
    expect(editorShortcut(event("d", { ctrlKey: false }), false)).toBeNull();
  });
});
