import { describe, expect, it } from "vitest";
import { mapExpression, remap, toBlendshapes } from "./expressions";

describe("remap", () => {
  it("clamps to 0..1", () => {
    expect(remap(-1, 0, 1)).toBe(0);
    expect(remap(0.5, 0, 1)).toBe(0.5);
    expect(remap(2, 0, 1)).toBe(1);
  });
  it("handles an empty range", () => {
    expect(remap(0.5, 0.5, 0.5)).toBe(1);
    expect(remap(0.4, 0.5, 0.5)).toBe(0);
  });
});

describe("mapExpression", () => {
  it("is neutral for a neutral face", () => {
    const e = mapExpression({});
    for (const w of Object.values(e.weights)) expect(w).toBe(0);
    expect(e.yaw).toBe(0);
    expect(e.pitch).toBe(0);
  });

  it("closes both eyes together on a real blink", () => {
    const e = mapExpression({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.55 });
    expect(e.weights.blinkLeft).toBe(1);
    expect(e.weights.blinkRight).toBe(1);
  });

  it("keeps a wink one-sided", () => {
    const e = mapExpression({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 });
    expect(e.weights.blinkLeft).toBe(1);
    expect(e.weights.blinkRight).toBe(0);
  });

  it("opens the mouth as aa, or oh when the lips are round", () => {
    expect(mapExpression({ jawOpen: 0.6 }).weights.aa).toBeCloseTo(1);
    const round = mapExpression({ jawOpen: 0.6, mouthFunnel: 0.8 });
    expect(round.weights.oh).toBeCloseTo(1);
    expect(round.weights.aa).toBeCloseTo(0);
  });

  it("never lets the mouth shapes add up past 1", () => {
    const e = mapExpression({
      jawOpen: 0.3,
      mouthPucker: 0.5,
      mouthStretchLeft: 0.5,
      mouthStretchRight: 0.5,
      mouthSmileLeft: 1,
      mouthSmileRight: 1,
    });
    const { aa, ih, ou, ee, oh } = e.weights;
    expect(aa + ih + ou + ee + oh).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("reads a smile as happy", () => {
    expect(mapExpression({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }).weights.happy).toBeGreaterThan(0.8);
  });

  it("turns the eyes toward where the subject looks", () => {
    const e = mapExpression({ eyeLookOutLeft: 1, eyeLookInRight: 1, eyeLookUpLeft: 1, eyeLookUpRight: 1 });
    expect(e.yaw).toBeGreaterThan(0);
    expect(e.pitch).toBeGreaterThan(0);
  });

  it("builds a record from MediaPipe categories", () => {
    expect(toBlendshapes([{ categoryName: "jawOpen", score: 0.4 }])).toEqual({ jawOpen: 0.4 });
  });
});
