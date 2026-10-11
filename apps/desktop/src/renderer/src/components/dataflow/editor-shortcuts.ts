export type EditorShortcut = "undo" | "redo" | "copy" | "paste" | "duplicate";
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export function editorShortcut(
  event: ShortcutEvent,
  editable: boolean,
  selectedText = false,
): EditorShortcut | null {
  if (editable || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey))
    return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  if (event.shiftKey) return null;
  if (key === "c") return selectedText ? null : "copy";
  if (key === "v") return "paste";
  if (key === "d") return "duplicate";
  return null;
}
