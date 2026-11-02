import { describe, expect, it } from "vitest";
import { foldSearch } from "./format";

describe("foldSearch", () => {
  it("ignores case and accents", () => {
    expect(foldSearch("Αγάπη")).toBe(foldSearch("αγαπη"));
    expect(foldSearch("Beyoncé")).toBe("beyonce");
  });

  it("treats final sigma as sigma", () => {
    expect(foldSearch("ΈΡΩΤΑΣ")).toBe(foldSearch("ερωτας"));
    expect(foldSearch("έρωτας").includes(foldSearch("ερωτασ"))).toBe(true);
  });
});
