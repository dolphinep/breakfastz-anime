import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DEFAULT_TUNING, mapExpression, toBlendshapes, type FaceExpression } from "../../lib/expressions";
import { cutBelow, keepHeadOnly, type HeadPart } from "../../lib/headOnly";

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

export type Background = "camera" | "green";
export type Aspect = "16:9" | "9:16";

export interface HeadCamSettings {
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
  /** let hair and accessories swing (VRM spring bones) */
  springs: boolean;
  /** how far below the avatar's eyes hair may hang, in model cm (bigger = longer; ≥ HAIR_UNCUT = no cut) */
  hair: number;
}

export const HAIR_UNCUT = 40;

export const DEFAULT_SETTINGS: HeadCamSettings = {
  size: 1.15,
  offsetY: 0,
  offsetZ: -4,
  smoothing: 0.55,
  mirror: true,
  aspect: "16:9",
  background: "camera",
  privacyBlur: true,
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
  parts: HeadPart[];
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
    this.world.add(this.anchor);
    this.scene.add(this.world);

    this.video.muted = true;
    this.video.playsInline = true;
    if (import.meta.env.DEV) (window as unknown as { headcam: HeadCam }).headcam = this;
  }

  /** ask for the webcam and load the face tracker */
  async start(deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
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
    this.resize();
    this.loop();
  }

  /** load a .vrm from a URL or a file the user picked */
  async loadVrm(source: string | File): Promise<void> {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const name = typeof source === "string" ? (source.split("/").pop() ?? source) : source.name;
    try {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) throw new Error("This file has no VRM data");

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make it face +Z like VRM 1.0 (= the canonical face)

      const head = vrm.humanoid.getRawBoneNode("head");
      if (!head) throw new Error("This VRM has no head bone");
      const parts = keepHeadOnly(vrm.scene, head);

      if (vrm.lookAt) vrm.lookAt.autoUpdate = false;

      vrm.scene.updateMatrixWorld(true);
      const { eyes, ipd } = measureEyes(vrm, head);

      if (this.avatar) {
        this.inner.remove(this.avatar.vrm.scene);
        VRMUtils.deepDispose(this.avatar.vrm.scene);
      }
      this.avatar = { vrm, name, eyes, ipd, license: readLicense(vrm), parts };
      this.applyHair();
      this.inner.add(vrm.scene);
      this.place();
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
    this.settings = { ...this.settings, ...patch };
    if (patch.hair !== undefined) this.applyHair();
    this.place();
  }

  /** trim hair that would hang over your neck and shoulders */
  private applyHair() {
    if (!this.avatar) return;
    const h = this.settings.hair;
    cutBelow(this.avatar.parts, h >= HAIR_UNCUT ? -Infinity : this.avatar.eyes.y - h / 100);
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }

  // ---------- recording

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** record the composited picture (and the mic, if asked) */
  async startRecording(withMic: boolean): Promise<void> {
    const stream = this.output.captureStream(30);
    if (withMic) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      });
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
    }

    this.follow(dt);
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

  /** put the avatar head so its eyes land on yours, at the chosen size */
  private place() {
    if (!this.avatar) return;
    const you = this.calibration ?? { eyes: new THREE.Vector3(0, 3, 4), ipd: 6.3 };
    // VRM is in metres and roughly life-size; anime eye bones sit much closer together than
    // real eyes, so scale by your face (eye distance vs an average 6.3 cm), not by eye match
    const s = 100 * (you.ipd / AVERAGE_IPD_CM) * this.settings.size;
    this.inner.scale.setScalar(s);
    this.inner.position
      .copy(you.eyes)
      .add(new THREE.Vector3(0, this.settings.offsetY, this.settings.offsetZ))
      .sub(this.avatar.eyes.clone().multiplyScalar(s));
    this.avatar.vrm.springBoneManager?.reset();
  }

  private follow(dt: number) {
    const seen = performance.now() - this.lastSeen < LOST_AFTER_MS;
    if (!this.avatar || this.lastSeen === 0) {
      this.anchor.visible = false;
      return;
    }
    // frame-rate independent smoothing; snap on the very first pose
    const k = this.hasPose ? 1 - Math.pow(this.settings.smoothing, dt * 30) : 1;
    this.anchor.position.lerp(this.target.pos, k);
    this.anchor.quaternion.slerp(this.target.quat, k);
    this.anchor.scale.lerp(this.target.scale, k);
    if (!this.hasPose) {
      this.hasPose = true;
      this.anchor.updateMatrixWorld(true);
      this.avatar.vrm.springBoneManager?.reset();
    }
    this.anchor.visible = true;

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

  // ---------- drawing

  /** how many output pixels per video pixel (Shorts are upscaled to a full 1080×1920) */
  private outScale = 1;
  private sized = "";

  private resize() {
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const tall = this.settings.aspect === "9:16";
    this.output.height = tall ? 1920 : vh;
    this.output.width = tall ? 1080 : vw;
    this.outScale = this.output.height / vh;
    // render the head at output resolution so it stays sharp even when the video is upscaled
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(vw * this.outScale), Math.round(vh * this.outScale), false);
    this.camera.aspect = vw / vh;
    this.camera.updateProjectionMatrix();
    this.cropX = -1;
    this.sized = `${vw}x${vh}:${this.settings.aspect}`;
  }

  private cropX = -1;

  private composite(now: number, dt: number) {
    const ctx = this.output.getContext("2d");
    if (!ctx) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    if (this.sized !== `${vw}x${vh}:${this.settings.aspect}`) this.resize();

    const W = this.output.width;
    const H = this.output.height;
    // source window (in video pixels) — 9:16 follows your face slowly so you stay in frame
    const sw = Math.min(vw, Math.round((W / H) * vh));
    const want = Math.min(Math.max(this.faceX * vw - sw / 2, 0), vw - sw);
    this.cropX = this.cropX < 0 ? want : this.cropX + (want - this.cropX) * (1 - Math.pow(0.93, dt * 30));
    const sx = Math.round(this.cropX);

    const lost = now - this.lastSeen > LOST_AFTER_MS;
    const hide = this.settings.privacyBlur && (lost || !this.calibration || !this.avatar);

    ctx.save();
    if (this.settings.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    if (this.settings.background === "green") {
      ctx.fillStyle = "#00b140";
      ctx.fillRect(0, 0, W, H);
    } else {
      if (hide) ctx.filter = `blur(${Math.round(H / 18)}px)`;
      ctx.drawImage(this.video, sx, 0, sw, vh, 0, 0, W, H);
      ctx.filter = "none";
    }
    const g = this.outScale;
    if (this.anchor.visible) ctx.drawImage(this.renderer.domElement, sx * g, 0, sw * g, vh * g, 0, 0, W, H);
    ctx.restore();
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
