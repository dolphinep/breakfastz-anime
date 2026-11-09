import * as THREE from "three";

/** one skinned mesh, with what we need to show only part of it */
export interface AvatarPart {
  mesh: THREE.SkinnedMesh;
  /** original triangles (3 vertex indices each), grouped by material */
  groups: { tris: number[]; head: Uint8Array; minY: Float32Array; materialIndex?: number }[];
}

export interface RigidPart {
  mesh: THREE.Mesh;
  head: boolean;
}

export interface AvatarParts {
  skinned: AvatarPart[];
  rigid: RigidPart[];
}

/**
 * Indexes every triangle of a skinned avatar so parts of it can be shown later:
 * - `head`: all three vertices are mostly weighted to the head bone or anything below it
 *   (eyes, jaw, hair springs…). Works for any VRM — no mesh names assumed.
 * - `minY`: the triangle's lowest rest height, to cut long hair or show only the upper body.
 *
 * Call with the avatar at rest and its root at the origin.
 * @param keepAt how much head weight a vertex needs to count as "head" (0..1)
 */
export function indexAvatar(root: THREE.Object3D, head: THREE.Object3D, keepAt = 0.5): AvatarParts {
  const headBones = new Set<THREE.Object3D>();
  head.traverse((o) => headBones.add(o));
  const insideHead = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (headBones.has(p)) return true;
    return false;
  };

  root.updateMatrixWorld(true);
  const parts: AvatarParts = { skinned: [], rigid: [] };
  const v = new THREE.Vector3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const skinned = obj as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh) {
      // a rigid mesh (glasses, a hat) counts as head when it hangs under the head
      parts.rigid.push({ mesh, head: insideHead(mesh) });
      return;
    }

    const geo = skinned.geometry;
    const skinIndex = geo.getAttribute("skinIndex");
    const skinWeight = geo.getAttribute("skinWeight");
    const position = geo.getAttribute("position");
    if (!skinIndex || !skinWeight) return;

    const isHeadBone = skinned.skeleton.bones.map((b) => headBones.has(b));
    const vertexCount = skinIndex.count;
    const isHead = new Uint8Array(vertexCount);
    const restY = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      let w = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) {
        if (isHeadBone[skinIndex.getComponent(i, k)]) w += skinWeight.getComponent(i, k);
      }
      isHead[i] = w >= keepAt ? 1 : 0;
      restY[i] = v.fromBufferAttribute(position, i).applyMatrix4(skinned.matrixWorld).y;
    }

    const index = geo.index ? Array.from(geo.index.array) : [...Array(vertexCount).keys()];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: undefined }];
    const part: AvatarPart = { mesh: skinned, groups: [] };
    for (const g of groups) {
      const tris = index.slice(g.start, g.start + g.count);
      const n = tris.length / 3;
      const head = new Uint8Array(n);
      const minY = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
        head[t] = isHead[a] & isHead[b] & isHead[c];
        minY[t] = Math.min(restY[a], restY[b], restY[c]);
      }
      part.groups.push({ tris, head, minY, materialIndex: g.materialIndex });
    }
    // the bounds describe the rest pose; skinned meshes are drawn regardless
    skinned.frustumCulled = false;
    parts.skinned.push(part);
  });

  return parts;
}

/**
 * Shows only the triangles that pass: `headOnly` keeps the head (and hair),
 * `minY` hides anything that dips below that rest height (model units).
 */
export function showParts(parts: AvatarParts, opts: { headOnly: boolean; minY: number }): void {
  for (const { mesh, head } of parts.rigid) mesh.visible = !opts.headOnly || head;

  for (const { mesh, groups } of parts.skinned) {
    const geo = mesh.geometry;
    const out: number[] = [];
    const ranges: { start: number; count: number; materialIndex?: number }[] = [];
    for (const g of groups) {
      const start = out.length;
      for (let t = 0; t < g.minY.length; t++) {
        if ((opts.headOnly && !g.head[t]) || g.minY[t] < opts.minY) continue;
        out.push(g.tris[t * 3], g.tris[t * 3 + 1], g.tris[t * 3 + 2]);
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
