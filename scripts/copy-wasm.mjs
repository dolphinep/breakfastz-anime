// Copies MediaPipe's WASM runtime into public/ so the face tracker loads from our own origin (no CDN).
import { cpSync, mkdirSync } from "node:fs";
const from = new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url);
const to = new URL("../public/mediapipe/", import.meta.url);
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log("mediapipe wasm → public/mediapipe");
