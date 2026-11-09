/**
 * Maps MediaPipe face blendshapes (ARKit-style names, 0..1) to VRM expression weights
 * and eye look angles. Pure functions — no three.js, no DOM — so they are easy to test.
 */

export type Blendshapes = Record<string, number>;

export interface FaceExpression {
  /** VRM preset expression name → weight 0..1 */
  weights: Record<string, number>;
  /** eye look, degrees (positive yaw = looking to the avatar's left, positive pitch = up) */
  yaw: number;
  pitch: number;
}

export interface ExpressionTuning {
  /** blink starts closing at this eyeBlink value and is fully shut at blinkShut */
  blinkOpen: number;
  blinkShut: number;
  /** jawOpen value that counts as a fully open mouth */
  mouthFull: number;
  /** multiply how strong smiles / brows read (1 = as tracked) */
  emotion: number;
}

export const DEFAULT_TUNING: ExpressionTuning = {
  blinkOpen: 0.3,
  blinkShut: 0.6,
  mouthFull: 0.55,
  emotion: 1,
};

/** linear remap of v from [a, b] to [0, 1], clamped */
export function remap(v: number, a: number, b: number): number {
  if (b === a) return v >= b ? 1 : 0;
  const t = (v - a) / (b - a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const avg = (bs: Blendshapes, ...names: string[]) =>
  names.reduce((s, n) => s + (bs[n] ?? 0), 0) / names.length;

/** turn a MediaPipe categories array into a name → score record */
export function toBlendshapes(categories: readonly { categoryName: string; score: number }[]): Blendshapes {
  const out: Blendshapes = {};
  for (const c of categories) out[c.categoryName] = c.score;
  return out;
}

export function mapExpression(bs: Blendshapes, t: ExpressionTuning = DEFAULT_TUNING): FaceExpression {
  // ARKit names are from the subject's point of view; VRM blinkLeft is the avatar's left — same side
  let blinkLeft = remap(bs.eyeBlinkLeft ?? 0, t.blinkOpen, t.blinkShut);
  let blinkRight = remap(bs.eyeBlinkRight ?? 0, t.blinkOpen, t.blinkShut);
  // people rarely wink by accident: if both eyes are mostly closed, close them together
  if (blinkLeft > 0.5 && blinkRight > 0.5) blinkLeft = blinkRight = Math.max(blinkLeft, blinkRight);

  const smile = remap(avg(bs, "mouthSmileLeft", "mouthSmileRight") * t.emotion, 0.25, 0.75);
  const jaw = remap(bs.jawOpen ?? 0, 0.06, t.mouthFull);
  const round = remap(Math.max(bs.mouthPucker ?? 0, bs.mouthFunnel ?? 0), 0.25, 0.7);
  const wide = remap(avg(bs, "mouthStretchLeft", "mouthStretchRight"), 0.15, 0.5);

  // visemes: open mouth splits between aa (wide open) and oh (open + round);
  // a closed but round mouth is ou; a stretched/smiling mouth is ee / ih
  let aa = jaw * (1 - round);
  let oh = jaw * round;
  let ou = (1 - jaw) * round;
  let ee = wide * (1 - jaw) * (1 - round);
  let ih = smile * 0.4 * (1 - jaw);
  const total = aa + oh + ou + ee + ih;
  if (total > 1) {
    aa /= total;
    oh /= total;
    ou /= total;
    ee /= total;
    ih /= total;
  }

  const browUp = remap(bs.browInnerUp ?? 0, 0.35, 0.85);
  const eyesWide = remap(avg(bs, "eyeWideLeft", "eyeWideRight"), 0.2, 0.6);
  const surprised = Math.min(browUp, Math.max(eyesWide, jaw)) * t.emotion;
  const angry = remap(avg(bs, "browDownLeft", "browDownRight") * t.emotion, 0.35, 0.8) * (1 - smile);

  // happy closes anime eyes into arcs — don't stack it with a blink
  const happy = smile * (1 - Math.max(blinkLeft, blinkRight)) * 0.9;

  const lookLeft = avg(bs, "eyeLookOutLeft", "eyeLookInRight");
  const lookRight = avg(bs, "eyeLookInLeft", "eyeLookOutRight");
  const lookUp = avg(bs, "eyeLookUpLeft", "eyeLookUpRight");
  const lookDown = avg(bs, "eyeLookDownLeft", "eyeLookDownRight");

  return {
    weights: {
      blinkLeft,
      blinkRight,
      aa,
      ih,
      ou,
      ee,
      oh,
      happy,
      angry,
      surprised: clamp01(surprised),
    },
    yaw: (lookLeft - lookRight) * 25,
    pitch: (lookUp - lookDown) * 18,
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
