import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DEFAULT_TUNING, mapExpression, toBlendshapes, type FaceExpression } from "../../lib/expressions";
import { indexAvatar, showParts, type AvatarParts } from "../../lib/headOnly";
import { PersonEraser } from "./PersonEraser";

/**
 * MediaPipe's face geometry assumes a pinhole camera with this vertical field of view
 * (degrees, near 1 cm). Its facial transformation matrix maps the canonical face model
 * (centimetres, facing +Z) into that camera's space — so a three.js camera with the same
 * FOV lets us apply the matrix to the avatar head as-is.
 */
const MP_FOV = 63;
/** iris centre landmarks (478-point model) */
const IRIS_A = 468;
const IRIS_B = 473;
const NOSE_TIP = 1;
const CALIBRATION_FRAMES = 15;
/** the face counts as lost after this many ms without a detection */
const LOST_AFTER_MS = 250;
const AVERAGE_IPD_CM = 6.3;

/** camera = your real room · the rest cut you out (head mode) or replace you (half mode) */
export type Background = "camera" | "pastel" | "sky" | "night" | "green";
export type Quality = "hd" | "sd";

const BACKGROUNDS: Record<Exclude<Background, "camera">, string[]> = {
  pastel: ["#ffe0ec", "#fff4c2"],
  sky: ["#bfe6ff", "#e8f7ff"],
  night: ["#2b1b4a", "#6a3d8f"],
  green: ["#00b140", "#00b140"],
};
export type Aspect = "16:9" | "9:16";
/** head = only your head turns anime · half = an anime upper body replaces yours */
export type Mode = "head" | "half";

export interface HeadCamSettings {
  mode: Mode;
  /** avatar head size: 1 = the model's own (life-size) proportions, scaled to your face */
  size: number;
  /** nudge the head up/down and toward/away from the camera, in cm */
  offsetY: number;
  offsetZ: number;
  /** 0 = raw tracking (jittery), 0.9 = very smooth (laggy) */
  smoothing: number;
  mirror: boolean;
  aspect: Aspect;
  background: Background;
  /** blur the whole picture whenever the face is lost, so the real face never shows */
  privacyBlur: boolean;
  /** small breakfastz.dev mark in the corner of photos and clips */
  watermark: boolean;
  /** hd = 1080p camera + 1080×1920 Shorts · sd = 720p, for phones and slower computers */
  quality: Quality;
  /** let hair and accessories swing (VRM spring bones) */
  springs: boolean;
  /** how far below the avatar's eyes hair may hang, in model cm (bigger = longer; ≥ HAIR_UNCUT = no cut) */
  hair: number;
}

export const HAIR_UNCUT = 40;

export const DEFAULT_SETTINGS: HeadCamSettings = {
  mode: "half",
  size: 1.15,
  offsetY: 0,
  offsetZ: -4,
  smoothing: 0.55,
  mirror: true,
  aspect: "16:9",
  background: "camera",
  privacyBlur: true,
  watermark: true,
  quality: "hd",
  springs: true,
  hair: 12,
};

export interface HeadCamStatus {
  face: boolean;
  calibrated: boolean;
  fps: number;
  model: string | null;
  /** what the model's own license says about use in monetised videos */
  license: ModelLicense | null;
  /** half mode: was an empty-room picture captured? */
  cleanPlate: boolean;
}

export interface ModelLicense {
  /** may it be used in a channel that earns money? */
  commercial: boolean | null;
  credit: boolean | null;
  authors: string;
  url: string | null;
}

interface Calibration {
  /** where your eyes sit in the canonical face space (cm) */
  eyes: THREE.Vector3;
  /** your eye-to-eye distance in canonical space (cm) */
  ipd: number;
}

interface Avatar {
  vrm: VRM;
  name: string;
  license: ModelLicense;
  /** eye midpoint and eye distance of the avatar at rest (model units = metres) */
  eyes: THREE.Vector3;
  ipd: number;
  parts: AvatarParts;
  /** rest height of the hips (model units) — half mode shows everything above */
  hipsY: number;
}

export class HeadCam {
  readonly output: HTMLCanvasElement;
  settings: HeadCamSettings = { ...DEFAULT_SETTINGS };
  onStatus?: (s: HeadCamStatus) => void;

  private video = document.createElement("video");
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  // the scene is in metres (VRM's unit — spring bone stiffness, gravity and colliders assume it);
  // MediaPipe's centimetre poses live under `world`, scaled by 0.01 around the camera
  private camera = new THREE.PerspectiveCamera(MP_FOV, 16 / 9, 0.01, 100);
  private world = new THREE.Group();
  /** follows the tracked face pose */
  private anchor = new THREE.Group();
  /** places the avatar inside the face space (scale + offset from calibration) */
  private inner = new THREE.Group();
  /** half mode: holds the whole avatar upright in camera space */
  private body = new THREE.Group();
  private eraser = new PersonEraser();
  private fileset: WasmFileset | null = null;
  private avatar: Avatar | null = null;

  private calibration: Calibration | null = null;
  private calibrationSamples: Calibration[] = [];

  private raf = 0;
  private lastVideoTime = -1;
  private lastFrame = performance.now();
  private lastSeen = 0;
  private hasPose = false;
  private fps = 0;
  private statusAt = 0;

  private target = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  private expression: FaceExpression = { weights: {}, yaw: 0, pitch: 0 };
  private shown: Record<string, number> = {};
  private faceX = 0.5;

  private recorder: MediaRecorder | null = null;

  constructor(output: HTMLCanvasElement) {
    this.output = output;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const light = new THREE.DirectionalLight(0xffffff, Math.PI);
    light.position.set(0.3, 1, 1).normalize();
    this.scene.add(light, new THREE.AmbientLight(0xffffff, 0.4));
    this.anchor.add(this.inner);
    this.anchor.visible = false;
    this.world.scale.setScalar(0.01);
    this.world.add(this.anchor, this.body);
    this.scene.add(this.world);

    this.video.muted = true;
    this.video.playsInline = true;
    if (import.meta.env.DEV) (window as unknown as { headcam: HeadCam }).headcam = this;
  }

  /** ask for the webcam and load the face tracker */
  async start(deviceId?: string): Promise<void> {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: this.settings.quality === "hd" ? 1920 : 1280 },
        height: { ideal: this.settings.quality === "hd" ? 1080 : 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    if (!this.landmarker) {
      const base = import.meta.env.BASE_URL;
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`);
      this.fileset = fileset;
      const create = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/face_landmarker.task`, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      // GPU is much faster; fall back to CPU where WebGL2 compute isn't available
      this.landmarker = await create("GPU").catch(() => create("CPU"));
    }
    if (this.needsEraser()) await this.initEraser();
    this.resize();
    cancelAnimationFrame(this.raf);
    this.loop();
  }

  /** cutting you out is only needed when your real room isn't the background */
  private needsEraser(): boolean {
    return this.settings.mode === "half" || this.settings.background !== "camera";
  }

  private async initEraser() {
    if (!this.fileset) return;
    await this.eraser.init(this.fileset, `${import.meta.env.BASE_URL}models/selfie_segmenter.tflite`);
  }

  /** half mode: grab the empty room as the background (step out of frame first) */
  capturePlate(): void {
    this.eraser.capturePlate(this.video);
    this.emitStatus(true);
  }

  private loadSeq = 0;

  /** load a .vrm from a URL or a file the user picked; a newer call wins if they overlap */
  async loadVrm(source: string | File, onProgress?: (fraction: number) => void): Promise<void> {
    const seq = ++this.loadSeq;
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const name = typeof source === "string" ? (source.split("/").pop() ?? source) : source.name;
    try {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) throw new Error("This file has no VRM data");

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make it face +Z like VRM 1.0 (= the canonical face)

      const head = vrm.humanoid.getRawBoneNode("head");
      if (!head) throw new Error("This VRM has no head bone");
      const parts = indexAvatar(vrm.scene, head);
      const hips = vrm.humanoid.getRawBoneNode("hips");
      const hipsY = hips ? hips.getWorldPosition(new THREE.Vector3()).y : 0.9;

      if (vrm.lookAt) vrm.lookAt.autoUpdate = false;

      vrm.scene.updateMatrixWorld(true);
      const { eyes, ipd } = measureEyes(vrm, head);

      if (seq !== this.loadSeq) {
        VRMUtils.deepDispose(vrm.scene); // the user already picked another character
        return;
      }
      if (this.avatar) {
        this.avatar.vrm.scene.removeFromParent();
        VRMUtils.deepDispose(this.avatar.vrm.scene);
      }
      this.avatar = { vrm, name, eyes, ipd, license: readLicense(vrm), parts, hipsY };
      this.shown = {};
      this.applyMode();
      this.emitStatus(true);
    } finally {
      if (typeof source !== "string") URL.revokeObjectURL(url);
    }
  }

  /** start measuring your face again (look straight at the camera) */
  recalibrate(): void {
    this.calibration = null;
    this.calibrationSamples = [];
    this.emitStatus(true);
  }

  update(patch: Partial<HeadCamSettings>): void {
    const prev = this.settings;
    this.settings = { ...this.settings, ...patch };
    if (this.needsEraser()) void this.initEraser();
    if (patch.mode && patch.mode !== prev.mode) {
      this.applyMode();
    } else if (patch.hair !== undefined) this.applyCut();
    this.place();
  }

  /** move the avatar between the head rig and the body rig, and show the right triangles */
  private applyMode() {
    if (!this.avatar) return;
    const { vrm } = this.avatar;
    const half = this.settings.mode === "half";
    (half ? this.body : this.inner).add(vrm.scene);
    vrm.scene.position.set(0, 0, 0);
    vrm.humanoid.resetNormalizedPose();
    if (half) poseArmsDown(vrm);
    this.applyCut();
    this.place();
  }

  /** head mode: trim hair over your neck and shoulders · half mode: everything above the hips */
  private applyCut() {
    if (!this.avatar) return;
    if (this.settings.mode === "half") {
      showParts(this.avatar.parts, { headOnly: false, minY: this.avatar.hipsY - 0.04 });
      return;
    }
    const h = this.settings.hair;
    showParts(this.avatar.parts, { headOnly: true, minY: h >= HAIR_UNCUT ? -Infinity : this.avatar.eyes.y - h / 100 });
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }

  // ---------- recording

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** record the composited picture (and the mic, if asked) */
  private micReady: Promise<MediaStream> | null = null;

  /** open the mic ahead of time (e.g. during the countdown) so recording starts on the beat */
  prepareMic(): void {
    this.micReady ??= navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
    this.micReady.catch(() => (this.micReady = null));
  }

  async startRecording(withMic: boolean): Promise<void> {
    const stream = this.output.captureStream(30);
    if (withMic) {
      this.prepareMic();
      const mic = await this.micReady!;
      this.micReady = null;
      for (const t of mic.getAudioTracks()) stream.addTrack(t);
    }
    const mimeType = pickMime();
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        for (const t of stream.getTracks()) t.stop();
        resolve(new Blob(chunks, { type: rec.mimeType }));
      };
    });
    this.recordingDone = done;
    rec.start(1000);
    this.recorder = rec;
  }

  private recordingDone: Promise<Blob> | null = null;

  async stopRecording(): Promise<Blob | null> {
    if (!this.recorder || !this.recordingDone) return null;
    this.recorder.stop();
    const blob = await this.recordingDone;
    this.recorder = null;
    this.recordingDone = null;
    return blob;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.recorder?.stop();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.landmarker?.close();
    this.eraser.dispose();
    if (this.avatar) VRMUtils.deepDispose(this.avatar.vrm.scene);
    this.renderer.dispose();
  }

  // ---------- frame loop

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.fps = this.fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;

    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime && this.landmarker) {
      this.lastVideoTime = this.video.currentTime;
      this.onResult(this.landmarker.detectForVideo(this.video, now), now);
      if (this.needsEraser()) this.eraser.update(this.video, now);
    }

    this.follow(dt);
    if (this.needsSettle && this.hasPose) this.settleHair();
    this.avatar?.vrm.update(this.settings.springs ? dt : 0);
    this.renderer.render(this.scene, this.camera);
    this.composite(now, dt);

    if (now - this.statusAt > 250) this.emitStatus();
  };

  private onResult(r: FaceLandmarkerResult, now: number) {
    const matrix = r.facialTransformationMatrixes?.[0];
    const landmarks = r.faceLandmarks?.[0];
    if (!matrix || !landmarks) return;

    const m = new THREE.Matrix4().fromArray(matrix.data);
    m.decompose(this.target.pos, this.target.quat, this.target.scale);
    this.lastSeen = now;

    if (r.faceBlendshapes?.[0]) {
      this.expression = mapExpression(toBlendshapes(r.faceBlendshapes[0].categories), DEFAULT_TUNING);
    }
    this.faceX = landmarks[NOSE_TIP].x;

    if (!this.calibration && landmarks.length > IRIS_B) {
      this.calibrationSamples.push(this.measureYou(m, landmarks[IRIS_A], landmarks[IRIS_B]));
      if (this.calibrationSamples.length >= CALIBRATION_FRAMES) {
        const eyes = new THREE.Vector3();
        let ipd = 0;
        for (const s of this.calibrationSamples) {
          eyes.add(s.eyes);
          ipd += s.ipd;
        }
        const n = this.calibrationSamples.length;
        this.calibration = { eyes: eyes.divideScalar(n), ipd: ipd / n };
        this.calibrationSamples = [];
        this.place();
        this.emitStatus(true);
      }
    }
  }

  /**
   * Your eye midpoint and eye distance, in the canonical face space. The iris landmarks are
   * image positions; we cast them out to the face's depth, then undo the face pose.
   */
  private measureYou(m: THREE.Matrix4, a: { x: number; y: number }, b: { x: number; y: number }): Calibration {
    const depth = -new THREE.Vector3().setFromMatrixPosition(m).z;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(MP_FOV / 2));
    const aspect = this.camera.aspect;
    const cast = (p: { x: number; y: number }) =>
      new THREE.Vector3((p.x * 2 - 1) * depth * tanHalf * aspect, (1 - p.y * 2) * depth * tanHalf, -depth);
    const inv = m.clone().invert();
    const ea = cast(a).applyMatrix4(inv);
    const eb = cast(b).applyMatrix4(inv);
    return { eyes: ea.clone().add(eb).multiplyScalar(0.5), ipd: ea.distanceTo(eb) };
  }

  private you(): Calibration {
    return this.calibration ?? { eyes: new THREE.Vector3(0, 3, 4), ipd: 6.3 };
  }

  /** cm per model metre: VRM is roughly life-size; anime eye bones sit much closer together
   *  than real eyes, so scale by your face (eye distance vs an average 6.3 cm), not by eye match */
  private avatarScale(): number {
    return 100 * (this.you().ipd / AVERAGE_IPD_CM) * this.settings.size;
  }

  /** where your eyes are (plus the nudge), in the face's own space (cm) */
  private eyeTarget(): THREE.Vector3 {
    return this.you().eyes.clone().add(new THREE.Vector3(0, this.settings.offsetY, this.settings.offsetZ));
  }

  /** head mode: put the avatar head so its eyes land on yours, at the chosen size */
  private place() {
    if (!this.avatar) return;
    const s = this.avatarScale();
    this.inner.scale.setScalar(s);
    this.body.scale.setScalar(s);
    this.inner.position.copy(this.eyeTarget()).sub(this.avatar.eyes.clone().multiplyScalar(s));
    this.needsSettle = true;
  }

  /** set when the avatar jumps (new model, new size, first pose) — see {@link settleHair} */
  private needsSettle = false;

  /**
   * Hair springs remember where the head was. After a jump — the model appearing at your
   * face from the origin, or a new size — they'd whip up and fall back down. So: reset them
   * at the head's real place, then run a second of physics with the head still before
   * anyone sees a frame.
   */
  private settleHair() {
    const vrm = this.avatar?.vrm;
    const springs = vrm?.springBoneManager;
    this.needsSettle = false;
    if (!vrm || !springs) return;
    vrm.humanoid.update();
    this.scene.updateMatrixWorld(true);
    springs.reset();
    for (let i = 0; i < 60; i++) springs.update(1 / 60);
  }

  private follow(dt: number) {
    const seen = performance.now() - this.lastSeen < LOST_AFTER_MS;
    if (!this.avatar || this.lastSeen === 0) {
      this.anchor.visible = false;
      this.body.visible = false;
      return;
    }
    // frame-rate independent smoothing; snap on the very first pose
    const k = this.hasPose ? 1 - Math.pow(this.settings.smoothing, dt * 30) : 1;
    this.anchor.position.lerp(this.target.pos, k);
    this.anchor.quaternion.slerp(this.target.quat, k);
    this.anchor.scale.lerp(this.target.scale, k);
    if (!this.hasPose) {
      this.hasPose = true;
      this.needsSettle = true;
    }
    this.anchor.visible = this.settings.mode === "head";
    this.body.visible = this.settings.mode === "half";
    if (this.settings.mode === "half") this.followBody();

    const em = this.avatar.vrm.expressionManager;
    if (em) {
      const ke = seen ? 1 - Math.pow(0.35, dt * 30) : 0;
      for (const [name, w] of Object.entries(this.expression.weights)) {
        const v = (this.shown[name] ?? 0) + (w - (this.shown[name] ?? 0)) * ke;
        this.shown[name] = v;
        em.setValue(name, v);
      }
    }
    const look = this.avatar.vrm.lookAt;
    if (look) {
      look.yaw += (this.expression.yaw - look.yaw) * 0.4;
      look.pitch += (this.expression.pitch - look.pitch) * 0.4;
    }
  }

  /**
   * Half mode: the body stays upright and turns a little with your head; neck and head take
   * the rest of the rotation. Then the whole avatar is moved so its eyes sit on yours.
   */
  private followBody() {
    const { vrm } = this.avatar!;
    const q = this.anchor.quaternion;
    const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
    const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.y * 0.35, e.z * 0.2, "YXZ"));
    const rel = toRig(vrm, bodyQ.clone().invert().multiply(q));
    const neck = vrm.humanoid.getNormalizedBoneNode("neck");
    const head = vrm.humanoid.getNormalizedBoneNode("head");
    if (neck && head) {
      const nq = new THREE.Quaternion().slerp(rel, 0.4);
      neck.quaternion.copy(nq);
      head.quaternion.copy(nq.invert().multiply(rel));
    } else if (head) head.quaternion.copy(rel);
    breathe(vrm, performance.now() / 1000);

    vrm.humanoid.update();
    this.body.quaternion.copy(bodyQ);
    this.body.position.set(0, 0, 0);
    this.body.updateMatrixWorld(true);
    const eyesLocal = this.body.worldToLocal(eyeMidWorld(vrm, this.avatar!.eyes, this.body));

    this.anchor.updateMatrix();
    const target = this.eyeTarget().applyMatrix4(this.anchor.matrix);
    const s = this.avatarScale();
    this.body.position.copy(target).sub(eyesLocal.multiplyScalar(s).applyQuaternion(bodyQ));
  }

  // ---------- drawing

  /** how many output pixels per video pixel (Shorts are upscaled to a full 1080×1920) */
  private outScale = 1;
  private sized = "";

  private resize() {
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const tall = this.settings.aspect === "9:16";
    const long = this.settings.quality === "hd" ? 1920 : 1280;
    this.output.height = tall ? long : vh;
    this.output.width = tall ? Math.round((long * 9) / 16) : vw;
    this.outScale = this.output.height / vh;
    // render the head at output resolution so it stays sharp even when the video is upscaled
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(vw * this.outScale), Math.round(vh * this.outScale), false);
    this.camera.aspect = vw / vh;
    this.camera.updateProjectionMatrix();
    this.cropX = -1;
    this.sized = `${vw}x${vh}:${this.settings.aspect}:${this.settings.quality}`;
  }

  private cropX = -1;

  private composite(now: number, dt: number) {
    const ctx = this.output.getContext("2d");
    if (!ctx) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    if (this.sized !== `${vw}x${vh}:${this.settings.aspect}:${this.settings.quality}`) this.resize();

    const W = this.output.width;
    const H = this.output.height;
    // source window (in video pixels) — 9:16 follows your face slowly so you stay in frame
    const sw = Math.min(vw, Math.round((W / H) * vh));
    const want = Math.min(Math.max(this.faceX * vw - sw / 2, 0), vw - sw);
    this.cropX = this.cropX < 0 ? want : this.cropX + (want - this.cropX) * (1 - Math.pow(0.93, dt * 30));
    const sx = Math.round(this.cropX);

    const lost = now - this.lastSeen > LOST_AFTER_MS;
    const hide = this.settings.privacyBlur && (lost || !this.calibration || !this.avatar);
    const half = this.settings.mode === "half";

    ctx.save();
    if (this.settings.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    const blur = `blur(${Math.round(H / 18)}px)`;
    const bg = this.settings.background;
    if (bg === "camera") {
      if (hide) ctx.filter = blur;
      ctx.drawImage(this.video, sx, 0, sw, vh, 0, 0, W, H);
      ctx.filter = "none";
      if (half && !hide) this.eraser.draw(ctx, sx, sw, vh, W, H);
    } else {
      const [a, b] = BACKGROUNDS[bg];
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, a);
      grad.addColorStop(1, b);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // head mode keeps your real body, cut out of the room
      if (!half) {
        if (hide) ctx.filter = blur;
        this.eraser.drawPerson(ctx, sx, sw, vh, W, H);
        ctx.filter = "none";
      }
    }
    const g = this.outScale;
    if (this.anchor.visible || this.body.visible) ctx.drawImage(this.renderer.domElement, sx * g, 0, sw * g, vh * g, 0, 0, W, H);
    ctx.restore();
    if (this.settings.watermark) drawWatermark(ctx, W, H);
  }

  /** a still of exactly what the preview shows */
  snapshot(): Promise<Blob | null> {
    return new Promise((resolve) => this.output.toBlob(resolve, "image/png"));
  }

  private emitStatus(force = false) {
    const now = performance.now();
    if (!force && now - this.statusAt < 250) return;
    this.statusAt = now;
    this.onStatus?.({
      face: now - this.lastSeen < LOST_AFTER_MS,
      calibrated: !!this.calibration,
      fps: Math.round(this.fps),
      model: this.avatar?.name ?? null,
      license: this.avatar?.license ?? null,
      cleanPlate: this.eraser.clean,
    });
  }
}

/** avatar eye midpoint + eye distance at rest; falls back to typical proportions without eye bones */
function measureEyes(vrm: VRM, head: THREE.Object3D): { eyes: THREE.Vector3; ipd: number } {
  const l = vrm.humanoid.getRawBoneNode("leftEye");
  const r = vrm.humanoid.getRawBoneNode("rightEye");
  if (l && r) {
    const a = l.getWorldPosition(new THREE.Vector3());
    const b = r.getWorldPosition(new THREE.Vector3());
    const ipd = a.distanceTo(b);
    if (ipd > 1e-4) return { eyes: a.add(b).multiplyScalar(0.5), ipd };
  }
  const h = head.getWorldPosition(new THREE.Vector3());
  return { eyes: h.add(new THREE.Vector3(0, 0.06, 0.05)), ipd: 0.065 };
}

/** relaxed arms by your sides instead of the T-pose (normalized rig: avatar faces +Z, left arm on +X) */
function poseArmsDown(vrm: VRM) {
  const h = vrm.humanoid;
  const f = isVrm0(vrm) ? -1 : 1;
  h.getNormalizedBoneNode("leftUpperArm")?.rotation.set(0, 0, -1.2 * f);
  h.getNormalizedBoneNode("rightUpperArm")?.rotation.set(0, 0, 1.2 * f);
  h.getNormalizedBoneNode("leftLowerArm")?.rotation.set(0, -0.25 * f, 0);
  h.getNormalizedBoneNode("rightLowerArm")?.rotation.set(0, 0.25 * f, 0);
}

const isVrm0 = (vrm: VRM) => vrm.meta.metaVersion === "0";

/**
 * A rotation in our (camera / avatar-faces-+Z) frame, expressed in the normalized rig's frame.
 * VRM 0.x rigs face -Z and rotateVRM0 turned the scene 180° around Y, so X and Z rotations flip.
 */
function toRig(vrm: VRM, q: THREE.Quaternion): THREE.Quaternion {
  return isVrm0(vrm) ? new THREE.Quaternion(-q.x, q.y, -q.z, q.w) : q;
}

/** a slow breath so the body never looks frozen */
function breathe(vrm: VRM, t: number) {
  const chest = vrm.humanoid.getNormalizedBoneNode("upperChest") ?? vrm.humanoid.getNormalizedBoneNode("chest");
  chest?.rotation.set(Math.sin(t * 1.6) * 0.012 * (isVrm0(vrm) ? -1 : 1), 0, 0);
}

/** the avatar's current eye midpoint in world space (falls back to the head bone plus the rest offset) */
function eyeMidWorld(vrm: VRM, restEyes: THREE.Vector3, body: THREE.Object3D): THREE.Vector3 {
  const l = vrm.humanoid.getRawBoneNode("leftEye");
  const r = vrm.humanoid.getRawBoneNode("rightEye");
  if (l && r) return l.getWorldPosition(new THREE.Vector3()).add(r.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  return body.localToWorld(restEyes.clone());
}

function drawWatermark(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const size = Math.round(Math.min(W, H) * 0.028);
  ctx.save();
  ctx.font = `600 ${size}px Fredoka, Mitr, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = "rgba(42, 15, 8, 0.55)";
  ctx.fillStyle = "rgba(255, 253, 245, 0.92)";
  const x = W - size;
  const y = H - size;
  ctx.strokeText("breakfastz.dev", x, y);
  ctx.fillText("breakfastz.dev", x, y);
  ctx.restore();
}

function readLicense(vrm: VRM): ModelLicense {
  const meta = vrm.meta;
  if (meta.metaVersion === "1") {
    return {
      commercial: meta.commercialUsage ? meta.commercialUsage !== "personalNonProfit" : null,
      credit: meta.creditNotation ? meta.creditNotation === "required" : null,
      authors: meta.authors?.join(", ") ?? "",
      url: meta.licenseUrl ?? null,
    };
  }
  return {
    commercial: meta.commercialUssageName ? meta.commercialUssageName === "Allow" : null,
    credit: null,
    authors: meta.author ?? "",
    url: meta.otherLicenseUrl ?? null,
  };
}

function pickMime(): string {
  const options = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
