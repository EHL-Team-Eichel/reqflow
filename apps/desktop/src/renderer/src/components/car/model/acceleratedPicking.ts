import * as THREE from "three";

interface Node {
  bounds: THREE.Box3;
  children?: readonly [Node, Node];
  mesh?: THREE.Mesh;
  faces?: readonly number[];
}

/** Exact triangle picking with a small, indirect spatial index; render buffers stay untouched. */
export function acceleratePicking(mesh: THREE.Mesh): () => void {
  const geometry = mesh.geometry;
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  // Imported cars have a single material and a complete indexed triangle buffer.
  // Leave unusual geometries and small procedural parts on Three's standard raycast.
  if (
    !index ||
    !position ||
    index.count < 1536 ||
    Array.isArray(mesh.material) ||
    geometry.groups.length ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity ||
    mesh.morphTargetInfluences?.length
  )
    return () => {};

  const original = mesh.raycast;
  const point = new THREE.Vector3();
  const faceBounds: THREE.Box3[] = [];
  const centres: THREE.Vector3[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  for (let face = 0; face < index.count / 3; face++) {
    const box = new THREE.Box3();
    for (let vertex = 0; vertex < 3; vertex++)
      box.expandByPoint(point.fromBufferAttribute(position, index.getX(face * 3 + vertex)));
    faceBounds.push(box);
    centres.push(box.getCenter(new THREE.Vector3()));
  }
  const build = (faces: number[]): Node => {
    const bounds = new THREE.Box3();
    for (const face of faces) bounds.union(faceBounds[face]!);
    if (faces.length <= 96) {
      const leaf = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes))
        leaf.setAttribute(name, attribute);
      leaf.setIndex(
        faces.flatMap((face) => [
          index.getX(face * 3),
          index.getX(face * 3 + 1),
          index.getX(face * 3 + 2),
        ]),
      );
      leaf.boundingBox = bounds;
      // Attributes are shared with the whole source; use this leaf's bounds rather than
      // scanning every source vertex again for each leaf during startup.
      leaf.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      leaves.push(leaf);
      const proxy = new THREE.Mesh(leaf, mesh.material);
      return { bounds, mesh: proxy, faces };
    }
    const size = bounds.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
    faces.sort((a, b) => centres[a]![axis] - centres[b]![axis]);
    const middle = Math.floor(faces.length / 2);
    return { bounds, children: [build(faces.slice(0, middle)), build(faces.slice(middle))] };
  };
  const root = build(faceBounds.map((_, face) => face));
  const inverse = new THREE.Matrix4();
  const localRay = new THREE.Ray();
  const hits: THREE.Intersection[] = [];
  const raycast: THREE.Mesh["raycast"] = (raycaster, intersections) => {
    inverse.copy(mesh.matrixWorld).invert();
    localRay.copy(raycaster.ray).applyMatrix4(inverse);
    const visit = (node: Node) => {
      if (!localRay.intersectsBox(node.bounds)) return;
      if (node.children) {
        visit(node.children[0]);
        visit(node.children[1]);
      } else {
        const proxy = node.mesh!;
        proxy.matrixWorld.copy(mesh.matrixWorld);
        proxy.material = mesh.material;
        hits.length = 0;
        original.call(proxy, raycaster, hits);
        for (const hit of hits) {
          hit.object = mesh;
          if (hit.faceIndex != null) hit.faceIndex = node.faces![hit.faceIndex]!;
          intersections.push(hit);
        }
      }
    };
    visit(root);
  };
  mesh.raycast = raycast;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (mesh.raycast === raycast) mesh.raycast = original;
    geometry.removeEventListener("dispose", dispose);
    for (const leaf of leaves) leaf.dispose();
  };
  geometry.addEventListener("dispose", dispose);
  return dispose;
}
