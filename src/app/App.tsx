import {
  Camera,
  ChevronDown,
  Circle,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Mic,
  MicOff,
  RefreshCw,
  Share2,
  ShieldCheck,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  HAIR_UNCUT,
  HeadCam,
  type Background,
  type HeadCamSettings,
  type HeadCamStatus,
} from "@/features/headcam/HeadCam";
import { AVATAR_SOURCES, MODELS } from "@/config/models";
import { SITE } from "@/config/site";
import { checkSupport, isPhone } from "@/lib/device";

type Take = { url: string; name: string; kind: "photo" | "video"; blob: Blob };

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: "camera", label: "ห้องจริง" },
  { id: "pastel", label: "พาสเทล" },
  { id: "sky", label: "ฟ้า" },
  { id: "night", label: "กลางคืน" },
  { id: "green", label: "จอเขียว" },
];

const MAX_RECORD_S = 180;

const phone = isPhone();
const support = checkSupport();
const INITIAL: HeadCamSettings = { ...DEFAULT_SETTINGS, quality: phone ? "sd" : "hd", aspect: phone ? "9:16" : "16:9" };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<HeadCam | null>(null);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<HeadCamStatus>({
    face: false,
    calibrated: false,
    fps: 0,
    model: null,
    license: null,
    cleanPlate: false,
  });
  const [settings, setSettings] = useState<HeadCamSettings>(INITIAL);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recStart, setRecStart] = useState(0);
  const [now, setNow] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [countdown, setCountdown] = useState<{ n: number; text: string } | null>(null);
  /** which character is downloading right now (id, or "file" for the user's own) and how far */
  const [loading, setLoading] = useState<{ id: string; pct: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cam = new HeadCam(canvas);
    cam.settings = { ...INITIAL };
    cam.onStatus = setStatus;
    camRef.current = cam;
    // the default character loads with the page (it's also <link rel="preload">ed), before the camera
    void loadModel(MODELS[0].id, MODELS[0].file);
    return () => {
      cam.dispose();
      camRef.current = null;
    };
  }, []);

  const run = useCallback(async (label: string, job: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const start = (deviceId?: string) =>
    run("กำลังเปิดกล้อง…", async () => {
      const cam = camRef.current!;
      await cam.start(deviceId);
      setStarted(true);
      setCameras(await cam.listCameras());
    });

  /** download + show a character; a spinner with % sits on its card meanwhile */
  async function loadModel(id: string, source: string | File) {
    const cam = camRef.current;
    if (!cam) return;
    setLoading({ id, pct: 0 });
    setError(null);
    try {
      await cam.loadVrm(source, (f) => setLoading((l) => (l?.id === id ? { id, pct: Math.round(f * 100) } : l)));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading((l) => (l?.id === id ? null : l));
    }
  }

  const pickModel = (id: string) => {
    const m = MODELS.find((x) => x.id === id);
    if (!m || id === modelId) return;
    setModelId(id);
    void loadModel(id, m.file);
  };

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    setModelId("file");
    void loadModel("file", file);
  };

  const set = <K extends keyof HeadCamSettings>(key: K, value: HeadCamSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    camRef.current?.update({ [key]: value });
  };

  /** a 3-2-1 overlay, then the action */
  const countThen = (text: string, action: () => void) => {
    let n = 3;
    setCountdown({ n, text });
    const id = setInterval(() => {
      n -= 1;
      if (n === 0) {
        clearInterval(id);
        setCountdown(null);
        action();
      } else setCountdown({ n, text });
    }, 1000);
  };

  const showTake = (t: Take) =>
    setTake((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return t;
    });

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const stopRecording = useCallback(async () => {
    const cam = camRef.current;
    if (!cam?.recording) return;
    const blob = await cam.stopRecording();
    setRecording(false);
    if (blob) {
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      showTake({ url: URL.createObjectURL(blob), name: `anime-${stamp()}.${ext}`, kind: "video", blob });
    }
  }, []);

  const startRecording = () => {
    if (mic) camRef.current?.prepareMic();
    countThen("เตรียมตัว…", () =>
      run("", async () => {
        await camRef.current!.startRecording(mic);
        setRecStart(performance.now());
        setNow(performance.now());
        setRecording(true);
      }),
    );
  };

  const photo = async () => {
    const blob = await camRef.current?.snapshot();
    if (blob) showTake({ url: URL.createObjectURL(blob), name: `anime-${stamp()}.png`, kind: "photo", blob });
  };

  // recording timer + hard stop so a forgotten recording doesn't eat the memory
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const t = performance.now();
      setNow(t);
      if (t - recStart > MAX_RECORD_S * 1000) void stopRecording();
    }, 250);
    return () => clearInterval(id);
  }, [recording, recStart, stopRecording]);

  // keyboard: space = record / stop, P = photo
  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea, button, summary")) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (recording) void stopRecording();
        else if (!countdown) startRecording();
      } else if (e.key === "p" || e.key === "P") void photo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const share = async (t: Take) => {
    const file = new File([t.blob], t.name, { type: t.blob.type });
    try {
      await navigator.share({ files: [file], text: `ทำด้วย ${SITE.name} ${SITE.url}` });
    } catch {
      /* the user closed the share sheet */
    }
  };
  const canShare = (t: Take) =>
    typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([t.blob], t.name, { type: t.blob.type })] });

  const seconds = recording ? Math.max(0, Math.floor((now - recStart) / 1000)) : 0;
  const hint = !started
    ? null
    : !status.model
      ? loading
        ? `กำลังโหลดตัวละคร ${loading.pct}%`
        : "เลือกตัวละคร"
      : !status.face
        ? "ไม่เจอหน้า ขยับเข้ามาในกรอบ (ภาพจะเบลอไว้ก่อน)"
        : !status.calibrated
          ? "มองกล้องตรงๆ นิ่งๆ แป๊บนึงนะ"
          : null;

  return (
    <div className="app">
      <header className="top">
        <h1>
          {SITE.name} <span className="tag">beta</span>
        </h1>
        <p className="sub">กล้องที่เปลี่ยนหัวเป็นอนิเมะ ฟรี ไม่ต้องสมัคร ภาพไม่ออกจากเครื่อง</p>
      </header>

      <main className="layout">
        <div className="main-col">
          <section className="chars" aria-label="ตัวละคร">
            <div className="carousel-row">
              <div className="carousel" role="list">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    role="listitem"
                    className={`avatar ${modelId === m.id ? "on" : ""}`}
                    aria-pressed={modelId === m.id}
                    onClick={() => pickModel(m.id)}
                    title={m.license}
                  >
                    <img src={m.thumb} alt="" width={160} height={160} />
                    <span>{m.name}</span>
                    {loading?.id === m.id && <Spinner pct={loading.pct} />}
                  </button>
                ))}
              </div>
              <label className={`avatar upload ${modelId === "file" ? "on" : ""}`} title="ใช้ไฟล์ .vrm ของเราเอง">
                <Upload size={22} />
                <span>ไฟล์ของฉัน</span>
                {loading?.id === "file" && <Spinner pct={loading.pct} />}
                <input type="file" accept=".vrm,.glb" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
              </label>
            </div>
            <div className="chars-foot">
              <details className="sources">
                <summary>
                  หาตัวละครฟรีเพิ่ม <ChevronDown size={14} />
                </summary>
                <ul>
                  {AVATAR_SOURCES.map((x) => (
                    <li key={x.url}>
                      <a href={x.url} target="_blank" rel="noreferrer">
                        {x.label} <ExternalLink size={12} />
                      </a>
                      <span>{x.note}</span>
                    </li>
                  ))}
                </ul>
                <p className="note">ได้ไฟล์ .vrm มาแล้วกด "ไฟล์ของฉัน" · ตัวละครลิขสิทธิ์ (เช่นตัวการ์ตูนดัง) เล่นเองได้ แต่อย่าเอาไปหาเงิน</p>
              </details>
              {status.license && (
                <p className={`license ${status.license.commercial ? "ok" : "no"}`}>
                  {status.license.commercial === null
                    ? "ไฟล์ไม่ได้บอกว่าใช้เชิงพาณิชย์ได้ไหม ถ้าจะลงช่องที่มีรายได้ เช็กกับคนทำก่อน"
                    : status.license.commercial
                      ? "ตัวนี้ใช้ลงช่องที่มีรายได้ได้"
                      : "ตัวนี้ห้ามใช้หาเงิน ใช้เล่นส่วนตัวได้"}
                  {status.license.credit && " · ต้องให้เครดิตคนทำ"}
                </p>
              )}
            </div>
          </section>

          <section className={`stage ${settings.aspect === "9:16" ? "tall" : ""}`}>
            <canvas ref={canvasRef} className="screen" />
            {!started && <Intro busy={!!busy} onStart={() => start()} />}
            {hint && !countdown && !busy && <div className="hint">{hint}</div>}
            {recording && (
              <div className="rec">
                <Circle size={12} fill="currentColor" /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              </div>
            )}
            {busy && started && <div className="hint">{busy}</div>}
            {countdown && (
              <div className="countdown">
                {countdown.n}
                <span>{countdown.text}</span>
              </div>
            )}
          </section>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="shoot">
            <button className="round" disabled={!started || recording} onClick={photo} title="ถ่ายรูป (P)">
              <ImageIcon size={22} />
              <span>ถ่ายรูป</span>
            </button>
            <button
              className={`round big ${recording ? "stop" : "go"}`}
              disabled={!started || !!countdown}
              onClick={() => (recording ? void stopRecording() : startRecording())}
              title="อัดคลิป (Space)"
            >
              {recording ? <Square size={26} /> : <Circle size={26} fill="currentColor" />}
              <span>{recording ? "หยุด" : "อัดคลิป"}</span>
            </button>
            <button className={`round ${mic ? "" : "off"}`} disabled={recording} onClick={() => setMic(!mic)} title="อัดเสียงด้วย">
              {mic ? <Mic size={22} /> : <MicOff size={22} />}
              <span>{mic ? "มีเสียง" : "ไม่มีเสียง"}</span>
            </button>
            <div className="seg">
              <Toggle label="16:9" on={settings.aspect === "16:9"} onClick={() => set("aspect", "16:9")} />
              <Toggle label="9:16" on={settings.aspect === "9:16"} onClick={() => set("aspect", "9:16")} />
            </div>
          </div>
          {!phone && <p className="keys">คีย์ลัด: Space = อัด / หยุด · P = ถ่ายรูป</p>}
        </div>

        <aside className="panel">

          <fieldset>
            <legend>โหมด</legend>
            <div className="seg wide">
              <Toggle label="แค่หัว" on={settings.mode === "head"} onClick={() => set("mode", "head")} />
              <Toggle label="ครึ่งตัว" on={settings.mode === "half"} onClick={() => set("mode", "half")} />
            </div>
            <p className="note">
              {settings.mode === "head" ? "หัวเป็นอนิเมะ ตัวกับมือยังเป็นเรา" : "ตัวละครทั้งท่อนบนแทนเรา (มือยังไม่ขยับตาม)"}
            </p>
            {settings.mode === "half" && settings.background === "camera" && (
              <>
                <button disabled={!started || !!countdown} onClick={() => countThen("หลบออกจากกล้องก่อน", () => camRef.current?.capturePlate())}>
                  <Camera size={16} /> ถ่ายห้องเปล่า (นับ 3 วิ)
                </button>
                <p className="note">
                  {status.cleanPlate ? "ได้ภาพห้องเปล่าแล้ว เนียนสุด" : "ถ่ายห้องตอนไม่มีเราไว้ก่อน ขอบรอบตัวจะเนียนขึ้นมาก"}
                </p>
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>พื้นหลัง</legend>
            <div className="bgs">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.id}
                  className={`bg bg-${b.id} ${settings.background === b.id ? "on" : ""}`}
                  aria-pressed={settings.background === b.id}
                  onClick={() => set("background", b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </fieldset>

          <details className="more">
            <summary>
              ปรับละเอียด <ChevronDown size={14} />
            </summary>
            <div className="more-body">
              <Slider label="ขนาดหัว" min={0.6} max={2} step={0.05} value={settings.size} onChange={(v) => set("size", v)} fmt={(v) => `${v.toFixed(2)}×`} />
              <Slider label="ขึ้น / ลง" min={-8} max={8} step={0.25} value={settings.offsetY} onChange={(v) => set("offsetY", v)} fmt={(v) => `${v} cm`} />
              <Slider label="หน้า / หลัง" min={-10} max={6} step={0.25} value={settings.offsetZ} onChange={(v) => set("offsetZ", v)} fmt={(v) => `${v} cm`} />
              <Slider
                disabled={settings.mode === "half"}
                label="ความยาวผม"
                min={6}
                max={HAIR_UNCUT}
                step={1}
                value={settings.hair}
                onChange={(v) => set("hair", v)}
                fmt={(v) => (v >= HAIR_UNCUT ? "ไม่ตัด" : `${v} cm`)}
              />
              <Slider label="ความนุ่ม" min={0} max={0.9} step={0.05} value={settings.smoothing} onChange={(v) => set("smoothing", v)} fmt={(v) => v.toFixed(2)} />
              <button disabled={!status.face} onClick={() => camRef.current?.recalibrate()}>
                <RefreshCw size={16} /> วัดหน้าใหม่
              </button>
              <Check label="กลับซ้ายขวา (กระจก)" on={settings.mirror} onChange={(v) => set("mirror", v)} />
              <Check label="เบลอภาพเมื่อไม่เจอหน้า" on={settings.privacyBlur} onChange={(v) => set("privacyBlur", v)} />
              <Check label="ผมแกว่งตามหัว" on={settings.springs} onChange={(v) => set("springs", v)} />
              <Check label="ลายน้ำ breakfastz.dev" on={settings.watermark} onChange={(v) => set("watermark", v)} />
              <Check
                label="ภาพชัดสูง (ปิดถ้าเครื่องกระตุก)"
                on={settings.quality === "hd"}
                disabled={recording}
                onChange={(v) => {
                  set("quality", v ? "hd" : "sd");
                  if (started) void start();
                }}
              />
              {cameras.length > 1 && (
                <select onChange={(e) => start(e.target.value)} defaultValue="" disabled={recording}>
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
              <p className="stats">
                {status.fps} fps · หน้า {status.face ? "เจอ" : "ไม่เจอ"} · วัดหน้า {status.calibrated ? "แล้ว" : "ยัง"}
              </p>
            </div>
          </details>
        </aside>
      </main>

      <section className="info">
        <div>
          <h2>
            <ShieldCheck size={18} /> ปลอดภัยไว้ก่อน
          </h2>
          <ul>
            <li>ภาพจากกล้องประมวลผลในเครื่องเราเท่านั้น ไม่มีการอัปโหลด ไม่ต้องสมัคร ไม่เก็บอะไรเลย</li>
            <li>ถ้าหันหลบหรือหลุดเฟรม ภาพจะเบลอเองกันหน้าหลุด แต่ดูคลิปอีกรอบก่อนโพสต์ทุกครั้ง</li>
            <li>เช็กว่าในคลิปไม่มีชื่อโรงเรียน ป้ายชื่อ บ้านเลขที่ หรือของที่บอกว่าเราเป็นใคร</li>
          </ul>
        </div>
        <div>
          <h2>เครื่องที่ใช้ได้</h2>
          <ul>
            <li>คอมพิวเตอร์ (Chrome, Edge, Safari) ลื่นสุด</li>
            <li>
              มือถือรุ่นใหม่ใช้ได้ แต่ <b>มือถือรุ่นเก่าหรือเครื่องสเปกต่ำอาจกระตุกหรือรันไม่ไหว</b> ลองปิด "ภาพชัดสูง" ในปรับละเอียด
            </li>
            <li>ครั้งแรกต้องโหลดตัวละครราว 5–6 MB แนะนำต่อ Wi-Fi</li>
          </ul>
          {!support.ok && <p className="error">เบราว์เซอร์นี้ยังไม่รองรับ: {support.missing.join(", ")} ลองเปิดใน Chrome หรือ Safari ล่าสุด</p>}
        </div>
      </section>

      {take && (
        <div className="sheet" role="dialog" aria-label="ผลงาน">
          <div className="sheet-card">
            <button className="close" onClick={() => setTake(null)} aria-label="ปิด">
              <X size={18} />
            </button>
            <h2>{take.kind === "photo" ? "ได้รูปแล้ว" : "ได้คลิปแล้ว"}</h2>
            {take.kind === "photo" ? <img src={take.url} alt="รูปที่ถ่าย" /> : <video src={take.url} controls playsInline />}
            <p className="note">ดูให้แน่ใจว่าไม่มีหน้าหลุดก่อนโพสต์นะ</p>
            <div className="row">
              <a className="button primary" href={take.url} download={take.name}>
                <Download size={16} /> บันทึก
              </a>
              {canShare(take) && (
                <button onClick={() => share(take)}>
                  <Share2 size={16} /> แชร์
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="foot">
        ทำโดย{" "}
        <a href={SITE.hub} target="_blank" rel="noreferrer">
          breakfastz
        </a>{" "}
        · ตัวจับหน้า MediaPipe · ตัวละคร VRM จาก VRoid / pixiv ·{" "}
        <a href={SITE.github.repo} target="_blank" rel="noreferrer">
          source code
        </a>
      </footer>
    </div>
  );
}

function Spinner({ pct }: { pct: number }) {
  return (
    <span className="spinner" role="status" aria-label={`กำลังโหลด ${pct}%`}>
      <span className="ring" />
      <b>{pct}%</b>
    </span>
  );
}

function Intro({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div className="overlay">
      <div className="intro">
        <ol>
          <li>
            <b>1</b> เปิดกล้อง
          </li>
          <li>
            <b>2</b> เลือกตัวละคร
          </li>
          <li>
            <b>3</b> อัดคลิป แล้วโพสต์
          </li>
        </ol>
        <button className="big" disabled={busy} onClick={onStart}>
          <Camera size={22} /> {busy ? "กำลังเปิด…" : "เริ่มเลย"}
        </button>
        <p className="note">ภาพจากกล้องไม่ออกจากเครื่อง · มือถือรุ่นเก่าอาจรันไม่ไหว</p>
      </div>
    </div>
  );
}

function friendlyError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return 'ยังไม่ได้อนุญาตให้ใช้กล้อง กดรูปกล้อง/แม่กุญแจตรงแถบที่อยู่เว็บ เลือก "อนุญาต" แล้วกดเริ่มอีกครั้ง';
  if (name === "NotFoundError" || name === "OverconstrainedError") return "หากล้องไม่เจอ เสียบกล้องหรือเปิดกล้องในเครื่องก่อนนะ";
  if (name === "NotReadableError") return "กล้องถูกแอปอื่นใช้อยู่ (Zoom, Discord, LINE…) ปิดแอปนั้นก่อนแล้วลองใหม่";
  const msg = e instanceof Error ? e.message : String(e);
  if (/VRM|glTF|JSON|magic|Unexpected/i.test(msg)) return `เปิดไฟล์ตัวละครนี้ไม่ได้ ต้องเป็นไฟล์ .vrm (${msg})`;
  return `มีบางอย่างผิดพลาด: ${msg}`;
}

function Slider(p: {
  disabled?: boolean;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
}) {
  return (
    <label className={`slider ${p.disabled ? "off" : ""}`}>
      <span>
        {p.label} <b>{p.fmt(p.value)}</b>
      </span>
      <input type="range" disabled={p.disabled} min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
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
