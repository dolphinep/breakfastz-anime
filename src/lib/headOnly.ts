import * as THREE from "three";

/** one skinned mesh trimmed down to the triangles that move with the head */
export interface HeadPart {
  mesh: THREE.SkinnedMesh;
  /** kept triangles, 3 vertex indices each, grouped by material */
  groups: { tris: number[]; minY: number[]; materialIndex?: number }[];
}

/**
 * Keeps only the part of a skinned avatar that moves with the head:
 * a triangle survives when all three of its vertices are mostly weighted
 * to the head bone or anything below it (eyes, jaw, hair springs…).
 * Works for any VRM — no mesh names assumed.
 *
 * Call with the avatar at rest and its root at the origin: each triangle also remembers
 * its lowest rest height, so long hair can be cut later with {@link cutBelow}.
 *
 * @param keepAt how much head weight a vertex needs to count as "head" (0..1)
 */
export function keepHeadOnly(root: THREE.Object3D, head: THREE.Object3D, keepAt = 0.5): HeadPart[] {
  const headBones = new Set<THREE.Object3D>();
  head.traverse((o) => headBones.add(o));
  const insideHead = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (headBones.has(p)) return true;
    return false;
  };

  root.updateMatrixWorld(true);
  const parts: HeadPart[] = [];
  const v = new THREE.Vector3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const skinned = obj as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh) {
      // a rigid mesh (glasses, a hat) is kept when it hangs under the head
      mesh.visible = insideHead(mesh);
      return;
    }

    const geo = skinned.geometry;
    const skinIndex = geo.getAttribute("skinIndex");
    const skinWeight = geo.getAttribute("skinWeight");
    const position = geo.getAttribute("position");
    if (!skinIndex || !skinWeight) return;

    const isHeadBone = skinned.skeleton.bones.map((b) => headBones.has(b));
    const vertexCount = skinIndex.count;
    const keep = new Uint8Array(vertexCount);
    const restY = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      let w = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) {
        if (isHeadBone[skinIndex.getComponent(i, k)]) w += skinWeight.getComponent(i, k);
      }
      keep[i] = w >= keepAt ? 1 : 0;
      restY[i] = v.fromBufferAttribute(position, i).applyMatrix4(skinned.matrixWorld).y;
    }

    const index = geo.index ? Array.from(geo.index.array) : [...Array(vertexCount).keys()];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: undefined }];
    const part: HeadPart = { mesh: skinned, groups: [] };
    for (const g of groups) {
      const tris: number[] = [];
      const minY: number[] = [];
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const a = index[i], b = index[i + 1], c = index[i + 2];
        if (keep[a] && keep[b] && keep[c]) {
          tris.push(a, b, c);
          minY.push(Math.min(restY[a], restY[b], restY[c]));
        }
      }
      part.groups.push({ tris, minY, materialIndex: g.materialIndex });
    }
    // the bounds still describe the whole body; skinned meshes are drawn regardless
    skinned.frustumCulled = false;
    parts.push(part);
  });

  cutBelow(parts, -Infinity);
  return parts;
}

/** hide every head triangle that dips below `y` (rest height, model units) — trims long hair */
export function cutBelow(parts: HeadPart[], y: number): void {
  for (const { mesh, groups } of parts) {
    const geo = mesh.geometry;
    const out: number[] = [];
    const ranges: { start: number; count: number; materialIndex?: number }[] = [];
    for (const g of groups) {
      const start = out.length;
      for (let t = 0; t < g.minY.length; t++) {
        if (g.minY[t] >= y) out.push(g.tris[t * 3], g.tris[t * 3 + 1], g.tris[t * 3 + 2]);
      }
      ranges.push({ start, count: out.length - start, materialIndex: g.materialIndex });
    }
    mesh.visible = out.length > 0;
    geo.setIndex(out);
    if (geo.groups.length || ranges.length > 1 || ranges[0]?.materialIndex !== undefined) {
      geo.clearGroups();
      for (const r of ranges) geo.addGroup(r.start, r.count, r.materialIndex);
    }
  }
}
