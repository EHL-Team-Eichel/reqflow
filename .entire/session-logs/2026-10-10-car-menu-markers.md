# Car menu and marker work log

- Agent: OpenCode, GPT-6.1 Sol
- Date: 2026-10-10
- Branch: `codex/car-model-refinements`
- Scope: Car-tab navigation and menu-driven markers (WS3).
- Record type: manually reconstructed work log, not an Entire checkpoint or full transcript.

## Requests and delivered changes

1. Make Exterior and Interior expandable and add general subclasses with detailed parts,
   including Doors. Commit and push to the current branch.
   - Added expandable Exterior, Interior and Technology sections and subclasses such as
     Doors, Body & design, Lighting, Windows & mirrors, Seats and Cockpit & controls.
   - Kept existing detailed part IDs, requirement classification and part selection.
   - Added rolled-up requirement counts and navigation coverage tests.
   - Commit: `05cc7b8` — `ws3: add expandable car parts submenus`.
   - Pushed to `origin/codex/car-model-refinements`.

2. Start with every menu closed; opening a class activates its markings. Above eight
   markings, use small blue points; otherwise retain normal text and counts.
   - Menus now load collapsed and no markers are shown initially.
   - Opening a class shows its descendant parts, including parts without requirements.
   - Opening a subclass narrows marker focus. Closing it restores its parent; closing
     the active top-level class clears its markers and closes its child menus.
   - More than eight eligible part markers use blue dots. Eight or fewer use compact
     labels and requirement counts. The threshold counts parts, not requirements.
   - Markers remain clickable and have accessible names. Dots have compact hover titles.
   - Interior and Technology activation switches to the interior view. Existing exterior
     visibility and occlusion logic is preserved.
   - Part selection and returning to the index preserve menu expansion state.
   - Commit: `12afee2` — `ws3: activate car markers from collapsed class menus`.
   - Pushed to `origin/codex/car-model-refinements`.

## Verification

- First slice: typecheck passed; 290 tests passed, 25 skipped. Isolated Electron checks
  passed for group/subclass toggles and detailed door/seat selection with no requirements.
- Follow-up: typecheck passed; 386 tests passed, 25 skipped; production build passed;
  changed-file Prettier and diff checks passed.
- Follow-up isolated Electron checks passed: collapsed and marker-free load, class
  activation, dot/label threshold behavior, door and luggage labels with zero requirements,
  close/reset, interior view switching, dot selection and selection/back retention.
- Screenshots reviewed: collapsed load, Exterior dots, Doors labels and Interior submenus.
  Screenshots remain local under `apps/desktop/out/smoke/` and are not included in this log.
- Shared smoke runner built and generated 32 screenshots, but failed 12 assertions that
  expect automatic markers before a class is opened. This limitation was recorded in the
  WS3 handoff for WS1/WS0; the shared main-process smoke script was left unchanged.

## Change isolation

Concurrent model, component, visibility, idle-orbit and documentation work was preserved.
Only this session's navigation/marker changes and corresponding WS3 handoff entries were
staged for its commits. No BMW records, credentials or private data are included here.

## Entire capture status

When asked to publish this log, `entire status` reported tracking enabled for Claude Code
and OpenCode, with an OpenCode hooks-out-of-date warning. `entire session current` found
no active session, and `entire session list --json` returned an empty list. Consequently,
there was no captured transcript to attach with `entire session attach`.

This file preserves the work history without inventing an Entire session/checkpoint or
amending another session's commit. Existing hooks and settings were not modified.
