import { describe, expect, it } from "vitest";
import { edgeScrollStep } from "./useDragAutoScroll";

describe("edgeScrollStep", () => {
  // Visible area 0..800, 80px edge zones.
  it("does not scroll in the middle", () => {
    expect(edgeScrollStep(400, 0, 800)).toBe(0);
    expect(edgeScrollStep(80, 0, 800)).toBe(0);
    expect(edgeScrollStep(720, 0, 800)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom", () => {
    expect(edgeScrollStep(60, 0, 800)).toBeLessThan(0);
    expect(edgeScrollStep(740, 0, 800)).toBeGreaterThan(0);
  });

  it("speeds up toward the edge and caps past it", () => {
    expect(Math.abs(edgeScrollStep(10, 0, 800))).toBeGreaterThan(Math.abs(edgeScrollStep(70, 0, 800)));
    expect(edgeScrollStep(0, 0, 800)).toBe(-18);
    expect(edgeScrollStep(-50, 0, 800)).toBe(-18);
    expect(edgeScrollStep(900, 0, 800)).toBe(18);
  });

  it("respects an offset visible area", () => {
    expect(edgeScrollStep(110, 100, 600)).toBeLessThan(0);
    expect(edgeScrollStep(300, 100, 600)).toBe(0);
  });

  it("shrinks the zones for a short area so the middle stays still", () => {
    expect(edgeScrollStep(50, 0, 100)).toBe(0);
    expect(edgeScrollStep(10, 0, 100)).toBeLessThan(0);
  });
});
