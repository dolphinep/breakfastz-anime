import { ImageSegmenter, type FilesetResolver } from "@mediapipe/tasks-vision";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/**
 * Removes the real person from the camera picture (for the half-body mode, where the
 * avatar replaces your whole upper body). MediaPipe's selfie segmenter finds the person;
 * the area is filled from a "clean plate" of the room:
 * - captured on demand while you step out of frame, or
 * - built up automatically from every pixel that is not you (starts as a blurred frame).
 */
export class PersonEraser {
  private segmenter: ImageSegmenter | null = null;
  private mask = document.createElement("canvas");
  private plate = document.createElement("canvas");
  private layer = document.createElement("canvas");
  private scratch = document.createElement("canvas");
  private hasPlate = false;
  private video: HTMLVideoElement | null = null;
  /** true once a clean plate was captured with nobody in frame */
  clean = false;

  async init(fileset: WasmFileset, modelPath: string): Promise<void> {
    if (this.segmenter) return;
    const create = (delegate: "GPU" | "CPU") =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    this.segmenter = await create("GPU").catch(() => create("CPU"));
  }

  /** segment the current frame and keep the plate up to date */
  update(video: HTMLVideoElement, now: number): void {
    if (!this.segmenter) return;
    this.video = video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    fit(this.plate, vw, vh);
    fit(this.layer, vw, vh);
    fit(this.scratch, vw, vh);

    const result = this.segmenter.segmentForVideo(video, now);
    const conf = result.confidenceMasks?.[0];
    if (conf) {
      const w = conf.width;
      const h = conf.height;
      const data = conf.getAsFloat32Array();
      fit(this.mask, w, h);
      const mctx = this.mask.getContext("2d")!;
      const img = mctx.createImageData(w, h);
      // generous threshold: better to erase a bit of wall than leave an edge of you
      for (let i = 0; i < data.length; i++) img.data[i * 4 + 3] = data[i] > 0.15 ? 255 : 0;
      mctx.putImageData(img, 0, 0);
    }
    result.close();

    const pctx = this.plate.getContext("2d")!;
    if (!this.hasPlate) {
      pctx.filter = `blur(${Math.round(vh / 12)}px)`;
      pctx.drawImage(video, 0, 0, vw, vh);
      pctx.filter = "none";
      this.hasPlate = true;
    }
    // learn the room from everything that isn't you
    const sctx = this.scratch.getContext("2d")!;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, vw, vh);
    sctx.drawImage(video, 0, 0, vw, vh);
    sctx.globalCompositeOperation = "destination-out";
    sctx.filter = `blur(${Math.round(vh / 60)}px)`;
    sctx.drawImage(this.mask, 0, 0, vw, vh);
    sctx.drawImage(this.mask, 0, 0, vw, vh); // twice: grows the cut-out past your edge
    sctx.filter = "none";
    sctx.globalCompositeOperation = "source-over";
    pctx.globalAlpha = this.clean ? 0.05 : 0.25;
    pctx.drawImage(this.scratch, 0, 0);
    pctx.globalAlpha = 1;
  }

  /** take the whole current frame as the empty room (step out of frame first) */
  capturePlate(video: HTMLVideoElement): void {
    fit(this.plate, video.videoWidth, video.videoHeight);
    this.plate.getContext("2d")!.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    this.hasPlate = true;
    this.clean = true;
  }

  /** draw the room over where you are; same source window/destination as the video draw */
  draw(ctx: CanvasRenderingContext2D, sx: number, sw: number, sh: number, W: number, H: number): void {
    if (!this.hasPlate || !this.mask.width) return;
    const vw = this.plate.width;
    const vh = this.plate.height;
    const lctx = this.layer.getContext("2d")!;
    lctx.globalCompositeOperation = "source-over";
    lctx.clearRect(0, 0, vw, vh);
    lctx.drawImage(this.plate, 0, 0);
    lctx.globalCompositeOperation = "destination-in";
    lctx.filter = `blur(${Math.round(vh / 70)}px)`;
    lctx.drawImage(this.mask, 0, 0, vw, vh);
    lctx.drawImage(this.mask, 0, 0, vw, vh);
    lctx.filter = "none";
    lctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.layer, sx, 0, sw, sh, 0, 0, W, H);
  }

  /** draw only you (the real camera, cut out of the room) — for head mode on a fun background */
  drawPerson(ctx: CanvasRenderingContext2D, sx: number, sw: number, sh: number, W: number, H: number): void {
    if (!this.video || !this.mask.width) return;
    const vw = this.layer.width;
    const vh = this.layer.height;
    const lctx = this.layer.getContext("2d")!;
    lctx.globalCompositeOperation = "source-over";
    lctx.clearRect(0, 0, vw, vh);
    lctx.drawImage(this.video, 0, 0, vw, vh);
    lctx.globalCompositeOperation = "destination-in";
    lctx.filter = `blur(${Math.round(vh / 200)}px)`;
    lctx.drawImage(this.mask, 0, 0, vw, vh);
    lctx.filter = "none";
    lctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.layer, sx, 0, sw, sh, 0, 0, W, H);
  }

  dispose(): void {
    this.segmenter?.close();
    this.segmenter = null;
  }
}

function fit(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}
