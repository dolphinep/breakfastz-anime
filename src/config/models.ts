/** Avatars that ship with the app. All allow use in monetised videos (see each license). */
export interface BundledModel {
  id: string;
  label: string;
  file: string;
  license: string;
}

const base = import.meta.env.BASE_URL;

export const MODELS: BundledModel[] = [
  { id: "fumiriya", label: "ผู้ชาย · Fumiriya", file: `${base}models/cc0/Sakurada_Fumiriya.vrm`, license: "CC0 (VRoid sample)" },
  { id: "hairmale", label: "ผู้ชาย · Hair Sample", file: `${base}models/cc0/HairSample_Male.vrm`, license: "CC0 (VRoid sample)" },
  { id: "pixiv", label: "ผู้หญิง · pixiv sample", file: `${base}models/sample.vrm`, license: "VRM Public License 1.0, pixiv Inc." },
  { id: "shibu", label: "ผู้หญิง · Darkness Shibu", file: `${base}models/cc0/Darkness_Shibu.vrm`, license: "CC0 (VRoid sample)" },
  { id: "shino", label: "ผู้หญิง · Shino", file: `${base}models/cc0/Sendagaya_Shino.vrm`, license: "CC0 (VRoid sample)" },
];

/** where to find (or make) more free avatars — always check each model's own license */
export const AVATAR_SOURCES = [
  { label: "VRoid Studio", note: "ปั้นตัวละครเองฟรี export .vrm", url: "https://vroid.com/en/studio" },
  { label: "VRoid Hub", note: "คลังตัวละคร VRM ดาวน์โหลดได้บางตัว", url: "https://hub.vroid.com/en" },
  { label: "Open Source Avatars", note: "300+ ตัว CC0", url: "https://www.opensourceavatars.com/en/gallery" },
  { label: "Booth (VRM)", note: "ตลาดญี่ปุ่น มีของฟรีเยอะ", url: "https://booth.pm/en/search/VRM" },
  { label: "vrm-samples", note: "ตัวอย่าง VRoid ที่ใช้ในแอปนี้", url: "https://github.com/madjin/vrm-samples" },
] as const;
