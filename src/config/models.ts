/** Characters that ship with the app. Every one allows use in monetised videos (see `license`). */
export interface BundledModel {
  id: string;
  name: string;
  file: string;
  thumb: string;
  license: string;
}

const base = import.meta.env.BASE_URL;
const model = (id: string, name: string, license: string): BundledModel => ({
  id,
  name,
  file: `${base}avatars/${id}.vrm`,
  thumb: `${base}avatars/thumbs/${id}.png`,
  license,
});

const VROID_CC0 = "CC0 · VRoid Studio sample by pixiv";

const VROID_SAMPLE = "VRoid AvatarSample by pixiv · ใช้เชิงพาณิชย์ได้ ไม่ต้องให้เครดิต (ห้ามขายไฟล์)";

/** the first one is the default and is preloaded with the page; the rest load when picked */
export const MODELS: BundledModel[] = [
  model("pixiv", "Mira", "VRM Public License 1.0 · pixiv Inc."),
  model("ren", "Ren", VROID_SAMPLE),
  model("fumiriya", "Fumiriya", VROID_CC0),
  model("hairmale", "Kuro", VROID_CC0),
  model("shibu", "Shibu", VROID_CC0),
  model("shino", "Shino", VROID_CC0),
];

/** where to find (or make) more free avatars — always check each model's own license */
export const AVATAR_SOURCES = [
  { label: "VRoid Studio", note: "ปั้นตัวละครของตัวเองฟรี แล้ว export เป็น .vrm", url: "https://vroid.com/en/studio" },
  { label: "VRoid Hub", note: "คลังตัวละคร บางตัวให้โหลดฟรี", url: "https://hub.vroid.com/en" },
  { label: "Open Source Avatars", note: "300+ ตัว ใช้ฟรี (CC0)", url: "https://www.opensourceavatars.com/en/gallery" },
  { label: "Booth", note: "ตลาดญี่ปุ่น ค้นคำว่า VRM มีของฟรีเยอะ", url: "https://booth.pm/en/search/VRM" },
] as const;
