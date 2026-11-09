// Shrinks VRM files for the web: every texture is resized to at most MAX px and re-encoded as a
// palette PNG; the rest of the GLB (meshes, VRM extensions) is copied byte for byte.
// Also writes the model's own thumbnail (from its VRM meta) for the character picker.
//
// usage: node scripts/slim-models.mjs <in.vrm> <out.vrm> <thumb.png> [maxPx=1024]
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const [input, output, thumbOut, maxArg] = process.argv.slice(2);
if (!input || !output || !thumbOut) throw new Error("usage: slim-models.mjs <in.vrm> <out.vrm> <thumb.png> [maxPx]");
const MAX = Number(maxArg ?? 1024);

const glb = readFileSync(input);
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB file");
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen;
const binLen = glb.readUInt32LE(binStart);
const bin = glb.subarray(binStart + 8, binStart + 8 + binLen);

const viewBytes = (i) => {
  const v = json.bufferViews[i];
  return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
};

// the thumbnail image index: VRM 1.0 meta.thumbnailImage, VRM 0.x meta.texture (a texture index)
const vrm1 = json.extensions?.VRMC_vrm?.meta;
const vrm0 = json.extensions?.VRM?.meta;
const thumbImage = vrm1?.thumbnailImage ?? (vrm0?.texture >= 0 ? json.textures?.[vrm0.texture]?.source : undefined);

const replaced = new Map();
for (const [i, img] of (json.images ?? []).entries()) {
  if (img.bufferView === undefined) continue;
  const src = viewBytes(img.bufferView);
  if (i === thumbImage) {
    await sharp(src).resize(320, 320, { fit: "cover" }).png({ palette: true, quality: 85 }).toFile(thumbOut);
  }
  const meta = await sharp(src).metadata();
  const pipeline = sharp(src);
  if (Math.max(meta.width ?? 0, meta.height ?? 0) > MAX) pipeline.resize(MAX, MAX, { fit: "inside" });
  const out = await pipeline.png({ palette: true, quality: 90, effort: 8 }).toBuffer();
  if (out.length < src.length) {
    replaced.set(img.bufferView, out);
    img.mimeType = "image/png";
  }
}
if (thumbImage === undefined) console.warn(`${input}: no thumbnail in meta`);

// re-pack the binary chunk, keeping every view 4-byte aligned
const parts = [];
let offset = 0;
for (const [i, v] of json.bufferViews.entries()) {
  const bytes = replaced.get(i) ?? viewBytes(i);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) parts.push(Buffer.alloc(pad));
  offset += pad;
  v.byteOffset = offset;
  v.byteLength = bytes.length;
  v.buffer = 0;
  parts.push(bytes);
  offset += bytes.length;
}
const newBin = Buffer.concat([...parts, Buffer.alloc((4 - (offset % 4)) % 4)]);
json.buffers = [{ byteLength: newBin.length }];

let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);
const chunk = (len, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(output, Buffer.concat([header, chunk(jsonBuf.length, 0x4e4f534a), jsonBuf, chunk(newBin.length, 0x004e4942), newBin]));
console.log(`${input}: ${(glb.length / 1e6).toFixed(1)} MB → ${(newBin.length / 1e6).toFixed(1)} MB`);
