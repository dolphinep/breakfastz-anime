// Downloads the CC0 VRoid sample avatars (VRoid Studio beta samples, released by pixiv under CC0)
// into public/models/cc0/. They are 15–20 MB each, so they're fetched at build time instead of committed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REPO = "https://github.com/madjin/vrm-samples/raw/e16eb187100149a315ad92c3c9968f1d5baa6c7d/vroid/beta";
const MODELS = {
  "Sakurada_Fumiriya.vrm": "d8fb05f33e377df028cb6b9d58c441ce68326c41fa23f6c735d40c65ae3dc710",
  "Darkness_Shibu.vrm": "0b50573d2d054d98c0a6fc5a5ce872e1b2c8bff8718476ff72a9a68c48674fd8",
  "Sendagaya_Shino.vrm": "1e177c1a7b14f783a9c48395831db8616260d3bddd4154cb2784b779adca49b5",
};

const dir = new URL("../public/models/cc0/", import.meta.url);
mkdirSync(dir, { recursive: true });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

for (const [file, hash] of Object.entries(MODELS)) {
  const path = new URL(file, dir);
  if (existsSync(path) && sha(readFileSync(path)) === hash) continue;
  const res = await fetch(`${REPO}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== hash) throw new Error(`${file}: checksum mismatch`);
  writeFileSync(path, buf);
  console.log(`fetched ${file}`);
}
console.log("cc0 models ready");
