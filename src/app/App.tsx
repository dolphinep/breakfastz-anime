import { Camera, Circle, Download, RefreshCw, Square, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, HAIR_UNCUT, HeadCam, type HeadCamSettings, type HeadCamStatus } from "@/features/headcam/HeadCam";
import { SITE } from "@/config/site";

const SAMPLE_MODEL = `${import.meta.env.BASE_URL}models/sample.vrm`;

type Take = { url: string; name: string };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<HeadCam | null>(null);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<HeadCamStatus>({ face: false, calibrated: false, fps: 0, model: null, license: null });
  const [settings, setSettings] = useState<HeadCamSettings>(DEFAULT_SETTINGS);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recStart, setRecStart] = useState(0);
  const [now, setNow] = useState(0);
  const [take, setTake] = useState<Take | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cam = new HeadCam(canvas);
    cam.onStatus = setStatus;
    camRef.current = cam;
    return () => {
      cam.dispose();
      camRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [recording]);

  const run = useCallback(async (label: string, job: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const start = (deviceId?: string) =>
    run("กำลังเปิดกล้องและโหลดตัวจับหน้า…", async () => {
      const cam = camRef.current!;
      await cam.start(deviceId);
      setStarted(true);
      setCameras(await cam.listCameras());
      if (!status.model) await cam.loadVrm(SAMPLE_MODEL);
    });

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    run("กำลังโหลดหัว…", () => camRef.current!.loadVrm(file));
  };

  const set = <K extends keyof HeadCamSettings>(key: K, value: HeadCamSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    camRef.current?.update({ [key]: value });
  };

  const toggleRecording = async () => {
    const cam = camRef.current!;
    if (cam.recording) {
      const blob = await cam.stopRecording();
      setRecording(false);
      if (blob) {
        if (take) URL.revokeObjectURL(take.url);
        const ext = blob.type.includes("mp4") ? "mp4" : "webm";
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        setTake({ url: URL.createObjectURL(blob), name: `anime-head-${stamp}.${ext}` });
      }
      return;
    }
    await run("", async () => {
      await cam.startRecording(mic);
      setRecStart(performance.now());
      setNow(performance.now());
      setRecording(true);
    });
  };

  const seconds = recording ? Math.max(0, Math.floor((now - recStart) / 1000)) : 0;
  const hint = !started
    ? null
    : !status.model
      ? "เลือกไฟล์หัว (.vrm)"
      : !status.face
        ? "ไม่เจอหน้า — ขยับเข้ามาในกรอบ ภาพจะเบลอไว้ก่อน"
        : !status.calibrated
          ? "มองตรงกล้องนิ่งๆ แป๊บนึง กำลังวัดหน้า…"
          : null;

  return (
    <div className="app">
      <header className="top">
        <h1>
          Anime Head <span className="tag">{SITE.episode}</span>
        </h1>
        <p className="sub">หัวอนิเมะ ตัวจริง — กล้องเปลี่ยนแค่หัว ทุกอย่างรันในเครื่อง ไม่มีภาพออกไปไหน</p>
      </header>

      <main className="layout">
        <section className={`stage ${settings.aspect === "9:16" ? "tall" : ""}`}>
          <canvas ref={canvasRef} className="screen" />
          {!started && (
            <div className="overlay">
              <button className="big" disabled={!!busy} onClick={() => start()}>
                <Camera size={22} /> เปิดกล้อง
              </button>
            </div>
          )}
          {hint && <div className="hint">{hint}</div>}
          {recording && (
            <div className="rec">
              <Circle size={12} fill="currentColor" /> REC {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </div>
          )}
          {busy && <div className="hint">{busy}</div>}
        </section>

        <aside className="panel">
          {error && <p className="error">{error}</p>}

          <fieldset>
            <legend>หัว</legend>
            <p className="model">{status.model ?? "ยังไม่ได้โหลด"}</p>
            {status.license && (
              <p className={`license ${status.license.commercial ? "ok" : "no"}`}>
                {status.license.commercial === null
                  ? "ไฟล์ไม่ได้บอกเรื่องใช้เชิงพาณิชย์ — เช็กกับผู้สร้างก่อนลงช่อง"
                  : status.license.commercial
                    ? "ใช้ในช่องที่มีรายได้ได้"
                    : "ห้ามใช้เชิงพาณิชย์ — ใช้ลงช่องไม่ได้"}
                {status.license.credit && " · ต้องให้เครดิต"}
                {status.license.authors && ` · โดย ${status.license.authors}`}
              </p>
            )}
            <div className="row">
              <label className="button">
                <Upload size={16} /> เลือกไฟล์ .vrm
                <input type="file" accept=".vrm,.glb" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
              </label>
              <button disabled={!started} onClick={() => run("กำลังโหลดหัว…", () => camRef.current!.loadVrm(SAMPLE_MODEL))}>
                ตัวอย่าง
              </button>
            </div>
            <p className="note">ทำหัวเองฟรีด้วย VRoid Studio แล้ว export เป็น .vrm</p>
          </fieldset>

          <fieldset>
            <legend>ตำแหน่ง</legend>
            <Slider label="ขนาดหัว" min={0.6} max={2} step={0.05} value={settings.size} onChange={(v) => set("size", v)} fmt={(v) => `${v.toFixed(2)}×`} />
            <Slider label="ขึ้น / ลง" min={-8} max={8} step={0.25} value={settings.offsetY} onChange={(v) => set("offsetY", v)} fmt={(v) => `${v} cm`} />
            <Slider label="หน้า / หลัง" min={-10} max={6} step={0.25} value={settings.offsetZ} onChange={(v) => set("offsetZ", v)} fmt={(v) => `${v} cm`} />
            <Slider label="ความยาวผม" min={6} max={HAIR_UNCUT} step={1} value={settings.hair} onChange={(v) => set("hair", v)} fmt={(v) => (v >= HAIR_UNCUT ? "ไม่ตัด" : `${v} cm ใต้ตา`)} />
            <Slider label="ความนุ่ม" min={0} max={0.9} step={0.05} value={settings.smoothing} onChange={(v) => set("smoothing", v)} fmt={(v) => v.toFixed(2)} />
            <button disabled={!status.face} onClick={() => camRef.current?.recalibrate()}>
              <RefreshCw size={16} /> วัดหน้าใหม่
            </button>
          </fieldset>

          <fieldset>
            <legend>ภาพ</legend>
            <div className="row">
              <Toggle label="16:9" on={settings.aspect === "16:9"} onClick={() => set("aspect", "16:9")} />
              <Toggle label="9:16 Shorts" on={settings.aspect === "9:16"} onClick={() => set("aspect", "9:16")} />
            </div>
            <div className="row">
              <Toggle label="ฉากจริง" on={settings.background === "camera"} onClick={() => set("background", "camera")} />
              <Toggle label="พื้นเขียว" on={settings.background === "green"} onClick={() => set("background", "green")} />
            </div>
            <Check label="กลับซ้ายขวา (กระจก)" on={settings.mirror} onChange={(v) => set("mirror", v)} />
            <Check label="เบลอภาพเมื่อไม่เจอหน้า" on={settings.privacyBlur} onChange={(v) => set("privacyBlur", v)} />
            <Check label="ผมแกว่งตามหัว" on={settings.springs} onChange={(v) => set("springs", v)} />
            {cameras.length > 1 && (
              <select onChange={(e) => start(e.target.value)} defaultValue="">
                <option value="" disabled>
                  เปลี่ยนกล้อง
                </option>
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `กล้อง ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
          </fieldset>

          <fieldset>
            <legend>อัด</legend>
            <Check label="อัดเสียงไมค์ด้วย" on={mic} onChange={setMic} disabled={recording} />
            <button className={`big ${recording ? "stop" : ""}`} disabled={!started} onClick={toggleRecording}>
              {recording ? <Square size={18} /> : <Circle size={18} />} {recording ? "หยุดอัด" : "เริ่มอัด"}
            </button>
            {take && (
              <div className="take">
                <video src={take.url} controls playsInline />
                <a className="button" href={take.url} download={take.name}>
                  <Download size={16} /> ดาวน์โหลด
                </a>
              </div>
            )}
          </fieldset>

          <p className="stats">
            {status.fps} fps · หน้า {status.face ? "เจอ" : "ไม่เจอ"} · วัดหน้า {status.calibrated ? "แล้ว" : "ยัง"}
          </p>
        </aside>
      </main>

      <footer className="foot">
        by{" "}
        <a href={SITE.hub} target="_blank" rel="noreferrer">
          breakfastz
        </a>{" "}
        · ตัวจับหน้า MediaPipe · หัว VRM ผ่าน three-vrm · <a href={SITE.github.repo}>source</a>
      </footer>
    </div>
  );
}

function Slider(p: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label className="slider">
      <span>
        {p.label} <b>{p.fmt(p.value)}</b>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}

function Toggle(p: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`toggle ${p.on ? "on" : ""}`} aria-pressed={p.on} onClick={p.onClick}>
      {p.label}
    </button>
  );
}

function Check(p: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={p.on} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} /> {p.label}
    </label>
  );
}
