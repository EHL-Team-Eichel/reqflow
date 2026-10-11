import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { cx } from "@/lib/cx";
import { label } from "./classify";
import { partTag } from "./partTags";
import { markerPresentation } from "./markerMenu";
import { trackIdleOrbit } from "./idleOrbit";
import { buildCar, type CarPiece } from "./model/buildCar";
import { buildVehicleModel } from "./models/builder";
import { getVehicleModelById } from "./models/registry";
import type { PowertrainType } from "./models/types";
import { G60 } from "./model/body";
import { ExteriorFlight, type CarView } from "./model/exteriorFlight";
import {
  exteriorBadgeTargets,
  isPieceVisible,
  visibleExteriorBadgePoint,
} from "./model/visibility";
import {
  applyState,
  createOutlineMaterial,
  createPieceStyle,
  OUTLINED,
  readPalette,
  type PartState,
  type PieceStyle,
  type SketchPalette,
} from "./model/sketch";

export type { CarView } from "./model/exteriorFlight";
export type CameraPreset = "front" | "side" | "rear" | "top";

const PRESETS: Record<
  CameraPreset,
  { position: [number, number, number]; target: [number, number, number] }
> = {
  front: { position: [5.0, 2.1, -5.2], target: [0, 0.68, 0] },
  side: { position: [0, 1.1, -7.6], target: [0, 0.7, 0] },
  rear: { position: [-5.2, 2.3, -4.6], target: [0, 0.68, 0] },
  top: { position: [0.01, 8.4, -0.4], target: [0, 0.5, 0] },
};

interface Props {
  powertrain: PowertrainType;
  /** Requirement counts displayed on labeled markers. */
  counts: ReadonlyMap<string, number>;
  /** All parts in the active menu class, including parts without requirements. */
  markerParts: readonly string[];
  selected: string | null;
  view: CarView;
  preset: CameraPreset;
  /** Bumped to move the camera to `preset` again. */
  presetNonce: number;
  onSelect: (partId: string | null) => void;
  modelId?: string;
}

/**
 * The 3D car: drag to orbit, scroll to zoom, right-drag to pan. Hover shows the part's name, a click
 * selects it. The active menu class shows clickable labels/counts, or blue dots above eight parts.
 */
export function CarViewer(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const badgeRefs = useRef(new Map<string, HTMLButtonElement>());
  const propsRef = useRef(props);
  propsRef.current = props;
  const apiRef = useRef<{
    restyle: () => void;
    moveTo: (p: CameraPreset) => void;
    setView: (view: CarView) => void;
  } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<ReadonlyMap<string, THREE.Vector3>>(new Map());
  const [exteriorParts, setExteriorParts] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "WebGL is not available");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.dataset.testid = "car-canvas";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    camera.position.set(...PRESETS[propsRef.current.preset].position);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...PRESETS[propsRef.current.preset].target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.2;
    controls.maxDistance = 16;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.autoRotateSpeed = 0.8;
    controls.update();
    const idleOrbit = trackIdleOrbit(window);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const activeModel = props.modelId ? getVehicleModelById(props.modelId) : undefined;
    const car = activeModel
      ? buildVehicleModel(activeModel, props.powertrain)
      : buildCar(props.powertrain);
    scene.add(car.root);
    setAnchors(car.anchors);
    const exteriorTargets = exteriorBadgeTargets(car.pieces, car.anchors);
    const exteriorPartsForModel = new Set(exteriorTargets.keys());
    setExteriorParts(exteriorPartsForModel);
    const exteriorSurfaces = car.pieces
      .filter((piece) => isPieceVisible(piece, "exterior"))
      .map((piece) => piece.mesh);
    const badgeRaycaster = new THREE.Raycaster();
    const bounds = new THREE.Box3().setFromObject(car.root);
    const corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    const fittedPosition = (preset: CameraPreset) => {
      const target = new THREE.Vector3(...PRESETS[preset].target);
      const direction = new THREE.Vector3(...PRESETS[preset].position).sub(target).normalize();
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanH = tanV * camera.aspect;
      let distance = 0;
      for (const corner of corners) {
        const delta = corner.clone().sub(target);
        distance = Math.max(
          distance,
          delta.dot(direction) +
            Math.max(Math.abs(delta.dot(right)) / tanH, Math.abs(delta.dot(up)) / tanV),
        );
      }
      return target.addScaledVector(direction, distance * 1.12);
    };

    const viewFlight = new ExteriorFlight(car, propsRef.current.view);

    let palette: SketchPalette = readPalette();
    const outline = createOutlineMaterial(palette.ink, 1.4);
    const styles = new Map<CarPiece, PieceStyle>();
    const outlines = new Map<CarPiece, THREE.Mesh>();
    const pickable: THREE.Mesh[] = [];

    for (const piece of car.pieces) {
      const style = createPieceStyle(piece, palette);
      (piece.mesh.material as THREE.Material).dispose();
      piece.mesh.material = style.fill;
      styles.set(piece, style);
      // The body already has explicit panel/character lines and a silhouette.
      // Drawing tessellation creases adds stray spikes around the wheel arches.
      const threshold = piece.kind === "paint" || piece.kind === "glass" ? 180 : 40;
      const edgeGeometry = new THREE.EdgesGeometry(piece.mesh.geometry, threshold);
      const hasArches =
        piece.kind === "paint" &&
        ["body", "front_doors", "rear_doors"].includes(piece.partId ?? "");
      if (hasArches) {
        // Arch contours are drawn as smooth projected arcs, rather than the
        // cut grid's many inner and outer boundary segments.
        const positions = edgeGeometry.getAttribute("position");
        const clean: number[] = [];
        for (let k = 0; k < positions.count; k += 2) {
          const nearArch = [k, k + 1].some((v) =>
            [G60.frontAxleX, G60.rearAxleX].some(
              (axle) =>
                Math.hypot(positions.getX(v) - axle, positions.getY(v) - G60.tyreRadius) <
                G60.archRadius + 0.035,
            ),
          );
          if (nearArch) continue;
          for (const v of [k, k + 1])
            clean.push(positions.getX(v), positions.getY(v), positions.getZ(v));
        }
        edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(clean, 3));
      }
      const edges = new THREE.LineSegments(edgeGeometry, style.lines);
      edges.raycast = () => {};
      piece.mesh.add(edges);
      // Inverted hulls work on closed solids. On open body panels they expose
      // their back faces through arch openings and turn the triangulation into ink.
      if (
        OUTLINED.has(piece.kind) &&
        (!piece.mesh.geometry.userData.openSurface || (piece.kind === "paint" && !hasArches))
      ) {
        const hull = new THREE.Mesh(piece.mesh.geometry, outline);
        hull.raycast = () => {};
        piece.mesh.add(hull);
        outlines.set(piece, hull);
      }
    }
    const sketchStyles = car.sketchLines.map((geometry) => {
      const opacity = (geometry.userData.inkOpacity as number | undefined) ?? 0.35;
      const material = new THREE.LineBasicMaterial({
        color: palette.ink,
        transparent: true,
        opacity,
      });
      scene.add(new THREE.LineSegments(geometry, material));
      return { material, opacity };
    });

    let hoveredPart: string | null = null;
    let dirty = true;
    let needsPick = false;

    const restyle = () => {
      const { counts, selected, view } = propsRef.current;
      if (view === "exterior" && hoveredPart && !exteriorPartsForModel.has(hoveredPart)) {
        hoveredPart = null;
        setHovered(null);
      }
      scene.background = palette.background;
      outline.uniforms.color!.value.copy(palette.ink);
      for (const { material, opacity } of sketchStyles) {
        material.color.copy(palette.ink);
        material.opacity = opacity * (1 - THREE.MathUtils.smoothstep(viewFlight.progress, 0, 0.25));
      }
      host.dataset.viewProgress = viewFlight.progress.toFixed(3);
      host.dataset.viewAnimating = String(viewFlight.active);
      pickable.length = 0;
      for (const piece of car.pieces) {
        const visibility = viewFlight.pieces.get(piece)?.opacity ?? 1;
        piece.mesh.visible =
          visibility > 0 &&
          (piece.layer !== "interior" || viewFlight.progress > 0 || isPieceVisible(piece, view));
        const state: PartState =
          piece.partId && piece.partId === selected
            ? "selected"
            : piece.partId && piece.partId === hoveredPart
              ? "hover"
              : piece.partId && (counts.get(piece.partId) ?? 0) > 0
                ? "hasRequirements"
                : "idle";
        const canPick = applyState(piece, styles.get(piece)!, state, visibility, palette);
        const hull = outlines.get(piece);
        if (hull) hull.visible = visibility === 1;
        // Non-interactive surfaces (wheel-well shields) must still block clicks behind them.
        if (
          piece.mesh.visible &&
          visibility === 1 &&
          (piece.layer === "interior" || viewFlight.progress === 0) &&
          (canPick || piece.partId === null)
        )
          pickable.push(piece.mesh);
      }
      needsPick = true;
      dirty = true;
    };

    const setView = (view: CarView) => {
      viewFlight.setView(view, performance.now(), reducedMotion.matches);
      needsPick = true;
      restyle();
    };
    const onMotionPreference = () => setView(propsRef.current.view);
    reducedMotion.addEventListener("change", onMotionPreference);

    const onTheme = new MutationObserver(() => {
      palette = readPalette();
      restyle();
    });
    onTheme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // Camera moves between presets.
    let flight: {
      from: THREE.Vector3;
      to: THREE.Vector3;
      fromT: THREE.Vector3;
      toT: THREE.Vector3;
      t0: number;
    } | null = null;
    let activePreset: CameraPreset | null = propsRef.current.preset;
    const moveTo = (preset: CameraPreset) => {
      const p = PRESETS[preset];
      activePreset = preset;
      flight = {
        from: camera.position.clone(),
        to: fittedPosition(preset),
        fromT: controls.target.clone(),
        toT: new THREE.Vector3(...p.target),
        t0: performance.now(),
      };
    };
    const onOrbitStart = () => {
      flight = null;
      activePreset = null;
    };
    controls.addEventListener("start", onOrbitStart);
    apiRef.current = { restyle, moveTo, setView };

    // Picking.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerInside = false;
    let pointerPx = { x: 0, y: 0 };
    const pick = (): string | null => {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickable, false)[0];
      return (hit?.object.userData.partId as string | null | undefined) ?? null;
    };
    const setPointer = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointerPx = { x: e.clientX - r.left, y: e.clientY - r.top };
      pointer.set((pointerPx.x / r.width) * 2 - 1, -(pointerPx.y / r.height) * 2 + 1);
    };
    let down: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      setPointer(e);
      pointerInside = true;
      needsPick = true;
    };
    const onLeave = () => {
      pointerInside = false;
      needsPick = true;
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      setPointer(e);
      propsRef.current.onSelect(pick());
    };
    const el = renderer.domElement;
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (activePreset) {
        const position = fittedPosition(activePreset);
        controls.maxDistance = Math.max(16, position.distanceTo(controls.target) * 1.5);
        if (flight) flight.to.copy(position);
        else camera.position.copy(position);
      }
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      outline.uniforms.resolution!.value.copy(size);
      outline.uniforms.width!.value = 1.4 * renderer.getPixelRatio();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    restyle();

    // Render loop: only draws when something changed.
    const v = new THREE.Vector3();
    let frame = 0;
    let lastFrame = performance.now();
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (viewFlight.update(performance.now())) {
        restyle();
        needsPick = true;
      }
      const now = performance.now();
      const delta = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      if (flight) {
        const t = Math.min(1, (performance.now() - flight.t0) / 650);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        camera.position.lerpVectors(flight.from, flight.to, e);
        controls.target.lerpVectors(flight.fromT, flight.toT, e);
        if (t >= 1) flight = null;
        dirty = true;
      }
      controls.autoRotate = !flight && !reducedMotion.matches && idleOrbit.shouldRotate();
      host.dataset.autoRotating = String(controls.autoRotate);
      if (controls.autoRotate) activePreset = null;
      if (controls.update(delta)) {
        dirty = true;
        needsPick = true;
      }
      if (needsPick) {
        needsPick = false;
        const part = pointerInside ? pick() : null;
        if (part !== hoveredPart) {
          hoveredPart = part;
          setHovered(part);
          el.style.cursor = part ? "pointer" : "grab";
          restyle();
        }
      }
      const tip = tooltipRef.current;
      if (tip) tip.style.transform = `translate(${pointerPx.x + 14}px, ${pointerPx.y + 12}px)`;
      if (!dirty) return;
      dirty = false;
      renderer.render(scene, camera);
      // Badges follow their anchors.
      const { clientWidth: w, clientHeight: h } = host;
      for (const [partId, badge] of badgeRefs.current) {
        const anchor =
          propsRef.current.view === "exterior"
            ? visibleExteriorBadgePoint(
                partId,
                exteriorTargets.get(partId) ?? [],
                camera,
                exteriorSurfaces,
                badgeRaycaster,
              )
            : car.anchors.get(partId);
        if (!anchor) {
          badge.style.visibility = "hidden";
          continue;
        }
        const partFlight = viewFlight.badges.get(partId);
        v.copy(anchor);
        if (partFlight) v.addScaledVector(partFlight.offset, partFlight.amount);
        v.project(camera);
        const opacity = partFlight?.opacity ?? 1;
        const visible =
          opacity > 0 && v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        badge.style.visibility = visible ? "visible" : "hidden";
        badge.style.opacity = String(opacity);
        badge.style.pointerEvents = partFlight?.amount && viewFlight.progress > 0 ? "none" : "auto";
        badge.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      idleOrbit.dispose();
      ro.disconnect();
      onTheme.disconnect();
      reducedMotion.removeEventListener("change", onMotionPreference);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      controls.removeEventListener("start", onOrbitStart);
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) geometries.add(o.geometry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const s of styles.values()) {
        s.fill.dispose();
        s.lines.dispose();
      }
      outline.dispose();
      for (const { material } of sketchStyles) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      apiRef.current = null;
    };
  }, [props.modelId, props.powertrain]);

  // React to selection and counts without rebuilding the scene or restarting a flight.
  useEffect(() => {
    apiRef.current?.restyle();
  }, [props.counts, props.selected, props.markerParts]);

  useEffect(() => {
    apiRef.current?.setView(props.view);
  }, [props.view]);

  useEffect(() => {
    apiRef.current?.moveTo(props.preset);
  }, [props.preset, props.presetNonce]);

  if (failed) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-muted">
        <p>
          The 3D car needs WebGL, which isn't available here ({failed}). Pick a part from the list
          instead.
        </p>
      </div>
    );
  }

  const eligibleMarkers = new Set(
    [...anchors.keys()].filter((id) => props.view === "interior" || exteriorParts.has(id)),
  );
  const markers = markerPresentation(props.markerParts, eligibleMarkers);
  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden" data-testid="car-viewer">
      {markers.partIds.map((partId) => {
        const n = props.counts.get(partId) ?? 0;
        return (
          <button
            key={partId}
            type="button"
            ref={(el) => {
              if (el) badgeRefs.current.set(partId, el);
              else badgeRefs.current.delete(partId);
            }}
            onClick={() => props.onSelect(partId)}
            data-testid={`car-badge-${partId}`}
            data-marker-mode={markers.compact ? "dot" : "label"}
            title={`${partTag(partId)}: ${n} requirement${n === 1 ? "" : "s"}`}
            aria-label={`Review ${label(partId)}: ${n} requirement${n === 1 ? "" : "s"}`}
            aria-pressed={props.selected === partId}
            className={cx(
              "absolute top-0 left-0 flex items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              markers.compact
                ? "size-2.5 border-white bg-brand-fill hover:scale-150"
                : "h-6 gap-1.5 px-2 text-[11px] font-medium whitespace-nowrap",
              !markers.compact &&
                (props.selected === partId
                  ? "border-brand bg-brand-fill text-white"
                  : "border-brand bg-panel text-ink hover:bg-brand-soft"),
            )}
            style={{ visibility: "hidden" }}
          >
            {!markers.compact && (
              <>
                <span>{partTag(partId)}</span>
                <span className="text-[10px] opacity-70">{n}</span>
              </>
            )}
          </button>
        );
      })}
      <div
        ref={tooltipRef}
        className={cx(
          "pointer-events-none absolute top-0 left-0 rounded-md border border-line bg-panel px-2 py-1 text-xs font-medium text-ink shadow-sm",
          hovered ? "opacity-100" : "opacity-0",
        )}
      >
        {hovered ? partTag(hovered) : ""}
      </div>
    </div>
  );
}
