import { useEffect } from "react";
import { editorShortcut } from "./editor-shortcuts";
import { dataflowStore } from "./store";

/** Mounted only on Data Flow; native text editing and copyable evidence keep their shortcuts. */
export function EditorShortcuts() {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editable = Boolean(
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
        ),
      );
      const action = editorShortcut(event, editable, Boolean(window.getSelection()?.toString()));
      if (!action) return;
      const state = dataflowStore.getState();
      const applied =
        action === "undo"
          ? state.undo()
          : action === "redo"
            ? state.redo()
            : action === "copy"
              ? state.copySelection()
              : action === "paste"
                ? state.pasteSelection()
                : state.duplicateSelection();
      if (applied) event.preventDefault();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);
  return null;
}
