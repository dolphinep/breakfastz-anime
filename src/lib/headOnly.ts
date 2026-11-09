import * as THREE from "three";

/**
 * Keeps only the part of a skinned avatar that moves with the head:
 * a triangle survives when all three of its vertices are mostly weighted
 * to the head bone or anything below it (eyes, jaw, hair springs…).
 * Works for any VRM — no mesh names assumed. Mutates the index of each geometry.
 *
 * @param keepAt how much head weight a vertex needs to count as "head" (0..1)
 */
export function keepHeadOnly(root: THREE.Object3D, head: THREE.Object3D, keepAt = 0.5): void {
  const headBones = new Set<THREE.Object3D>();
  head.traverse((o) => headBones.add(o));

  const insideHead = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (headBones.has(p)) return true;
    return false;
  };

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
    if (!skinIndex || !skinWeight) return;

    const isHeadBone = skinned.skeleton.bones.map((b) => headBones.has(b));
    const vertexCount = skinIndex.count;
    const keep = new Uint8Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      let w = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) {
        if (isHeadBone[skinIndex.getComponent(v, k)]) w += skinWeight.getComponent(v, k);
      }
      keep[v] = w >= keepAt ? 1 : 0;
    }

    const index = geo.index ? Array.from(geo.index.array) : [...Array(vertexCount).keys()];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: 0 }];

    const out: number[] = [];
    const newGroups: { start: number; count: number; materialIndex?: number }[] = [];
    for (const g of groups) {
      const start = out.length;
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const a = index[i], b = index[i + 1], c = index[i + 2];
        if (keep[a] && keep[b] && keep[c]) out.push(a, b, c);
      }
      newGroups.push({ start, count: out.length - start, materialIndex: g.materialIndex });
    }

    if (out.length === 0) {
      skinned.visible = false;
      return;
    }
    geo.setIndex(out);
    if (geo.groups.length) {
      geo.clearGroups();
      for (const g of newGroups) geo.addGroup(g.start, g.count, g.materialIndex);
    }
    // the bounds still describe the whole body; skinned meshes are drawn regardless
    skinned.frustumCulled = false;
  });
}
