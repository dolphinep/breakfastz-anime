# Anime Head

Your webcam, but **only your head turns anime**. Your body, hands and gestures stay real, so viewers feel they're talking to a real person, without ever seeing your face.

Runs entirely in the browser. No video leaves your machine.

Made for the [breakfastz](https://breakfastz.dev) channel, EP.006.

## How it works

```
webcam → MediaPipe Face Landmarker ─┬─ facial transformation matrix → head pose (position + rotation)
                                    ├─ 52 blendshapes → VRM expressions (blink, mouth shapes, smile, brows) + eye look
                                    └─ iris landmarks → one-off calibration (where your eyes are, how big your face is)
                                             │
three.js + three-vrm renders ONLY the head of a VRM avatar on a transparent canvas, with a camera
that matches MediaPipe's own (63° vertical FOV) so the pose matrix can be applied as-is
                                             │
2D canvas composites: camera frame (or green screen) + head → preview + MediaRecorder (MP4/WebM)
```

- **Two modes:** *head only* (your real body stays) or *half body* (an anime upper body replaces yours: MediaPipe's selfie segmenter erases you and fills the area with a clean plate of the room, captured on demand or learned from every pixel that isn't you; the body turns a little with your head, neck and head take the rest).
- **Head only, any VRM:** triangles are kept when all three vertices are mostly skinned to the head bone or its children (`src/lib/headOnly.ts`), so no mesh names are assumed.
- **Expressions:** `src/lib/expressions.ts` maps ARKit-style blendshapes to VRM presets (`aa ih ou ee oh`, blinks, `happy`, `angry`, `surprised`).
- **Privacy guard:** whenever the face is lost (or before calibration) the whole picture is blurred, so your real face never shows in a recording.
- **Shorts mode:** 9:16 at 1080×1920; the crop follows your face slowly.
- **License check:** the model's own VRM license is shown (can it be used in a monetised channel? credit needed?).

## Run

```sh
bun install
bun run dev      # http://localhost:5173, allow the camera
bun run test     # unit tests
bun run build
```

## Your own head

Make one for free in [VRoid Studio](https://vroid.com/en/studio) and export `.vrm`, or pick one on [VRoid Hub](https://hub.vroid.com/) / Booth. Always read the model's license before using it in videos.

Bundled characters (switch in the app):
- `public/models/sample.vrm`: `VRM1_Constraint_Twist_Sample` by pixiv Inc. from [three-vrm](https://github.com/pixiv/three-vrm) (VRM Public License 1.0: commercial use and redistribution allowed, credit not required). Committed.
- Sakurada Fumiriya, Darkness Shibu (male) and Sendagaya Shino: VRoid Studio beta samples released by pixiv under **CC0** (license also stored in each file). 15–20 MB each, so `scripts/fetch-models.mjs` downloads them (pinned commit + SHA-256) from [madjin/vrm-samples](https://github.com/madjin/vrm-samples) on `dev` / `build`.

The pixiv sample is `VRM1_Constraint_Twist_Sample` by pixiv Inc. from [three-vrm](https://github.com/pixiv/three-vrm) (VRM Public License 1.0: commercial use and redistribution allowed, credit not required).

## Credits

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) and [Image Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (Apache-2.0). `face_landmarker.task` and `selfie_segmenter.tflite` are bundled in `public/models/`
- [three.js](https://threejs.org/) (MIT) · [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (MIT)

## License

MIT
