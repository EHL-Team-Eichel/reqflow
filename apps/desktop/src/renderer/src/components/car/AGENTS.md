# Car visualization — human-approved transition

On 2026-10-11 the human explicitly selected **Grey-line fade**, not **Pieces fly away**.

- Keep the car assembled in both views. Exterior fills/silhouettes fade out over the reversible
  850 ms timeline; faint grey exterior edges and character lines remain around the visible cabin.
- Never translate, explode, remove or fully hide exterior geometry for this transition. Badge
  anchors stay on the assembled car. Ghosted surfaces must not intercept cabin selection.
- Preserve rapid reversal, light/dark styling, selection and live reduced-motion endpoint snapping.
- Do not replace this behavior during model refinements or merges unless the human explicitly
  approves a different transition. Run `exteriorFade.test.ts`, `sketch.test.ts` and native smoke.

Provenance: original ghosted look in `f95ba3d`; reversible timing/reduced-motion behavior in
`5accfdf`; the grey-line preference supersedes that commit's fly-away geometry.
Implementation: `model/exteriorFade.ts`, `model/sketch.ts`, `CarViewer.tsx`.
