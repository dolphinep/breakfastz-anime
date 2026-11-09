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
  { id: "shibu", label: "ผู้ชาย · Darkness Shibu", file: `${base}models/cc0/Darkness_Shibu.vrm`, license: "CC0 (VRoid sample)" },
  { id: "pixiv", label: "ผู้หญิง · pixiv sample", file: `${base}models/sample.vrm`, license: "VRM Public License 1.0, pixiv Inc." },
  { id: "shino", label: "ผู้หญิง · Shino", file: `${base}models/cc0/Sendagaya_Shino.vrm`, license: "CC0 (VRoid sample)" },
];
