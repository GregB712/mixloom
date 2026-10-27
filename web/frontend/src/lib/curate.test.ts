import { describe, expect, it } from "vitest";
import type { Track } from "../api/client";
import {
  applySort,
  camelotDistance,
  energyCurveOrder,
  mixQuality,
  parseCamelot,
  smoothCurveOrder,
  smoothDanceOrder,
  totalDurationMs,
  vibeGroups,
} from "./curate";

// Minimal Track factory — only the fields the curation logic reads matter.
function track(partial: Partial<Track> & { uri: string }): Track {
  return {
    uri: partial.uri,
    title: partial.title ?? partial.uri,
    artists: partial.artists ?? "",
    album: partial.album ?? "",
    durationMs: partial.durationMs ?? null,
    bpm: partial.bpm ?? null,
    energy: partial.energy ?? null,
    valence: partial.valence ?? null,
    danceability: partial.danceability ?? null,
    acousticness: partial.acousticness ?? null,
    camelot: partial.camelot ?? null,
    musicalKey: partial.musicalKey ?? null,
    genre: partial.genre ?? null,
    mood: partial.mood ?? null,
    albumArt: partial.albumArt ?? null,
    greek: partial.greek ?? false,
  };
}

describe("parseCamelot", () => {
  it("parses valid codes", () => {
    expect(parseCamelot("8A")).toEqual({ n: 8, letter: "A" });
    expect(parseCamelot(" 12b ")).toEqual({ n: 12, letter: "B" });
  });
  it("rejects invalid or out-of-range codes", () => {
    expect(parseCamelot(null)).toBeNull();
    expect(parseCamelot("13A")).toBeNull();
    expect(parseCamelot("0B")).toBeNull();
    expect(parseCamelot("8C")).toBeNull();
    expect(parseCamelot("foo")).toBeNull();
  });
});

describe("camelotDistance", () => {
  it("is zero for the same key", () => {
    expect(camelotDistance("8A", "8A")).toBe(0);
  });
  it("is small for relative major/minor and neighbours", () => {
    expect(camelotDistance("8A", "8B")).toBe(0.5); // relative major/minor
    expect(camelotDistance("8A", "9A")).toBe(1); // one step on the wheel
  });
  it("wraps around the 12-o'clock boundary", () => {
    expect(camelotDistance("12A", "1A")).toBe(1);
  });
  it("gives a neutral penalty when a key is unknown", () => {
    expect(camelotDistance(null, "8A")).toBe(2.5);
  });
  it("penalises distant keys", () => {
    expect(camelotDistance("1A", "6B")).toBeGreaterThan(3);
  });
});

describe("mixQuality", () => {
  it("rates a same-key, same-tempo move as great", () => {
    const a = track({ uri: "a", camelot: "8A", bpm: 124, energy: 0.5 });
    const b = track({ uri: "b", camelot: "8A", bpm: 124, energy: 0.5 });
    expect(mixQuality(a, b)).toBe("great");
  });
  it("rates a big tempo/key clash as a jump", () => {
    const a = track({ uri: "a", camelot: "1A", bpm: 120, energy: 0.2 });
    const b = track({ uri: "b", camelot: "6B", bpm: 150, energy: 0.9 });
    expect(mixQuality(a, b)).toBe("jump");
  });
});

describe("applySort", () => {
  const tracks = [
    track({ uri: "a", bpm: 128, energy: 0.8 }),
    track({ uri: "b", bpm: 120, energy: 0.3 }),
    track({ uri: "c", bpm: 124, energy: 0.6 }),
  ];

  it("sorts by BPM ascending", () => {
    expect(applySort(tracks, "bpm").map((t) => t.uri)).toEqual(["b", "c", "a"]);
  });
  it("sorts by energy ascending", () => {
    expect(applySort(tracks, "energy").map((t) => t.uri)).toEqual(["b", "c", "a"]);
  });
  it("keeps order for manual", () => {
    expect(applySort(tracks, "manual").map((t) => t.uri)).toEqual(["a", "b", "c"]);
  });
  it("does not drop or duplicate tracks under any strategy", () => {
    for (const s of ["smooth", "curve", "smoothCurve", "smoothDance", "bpm", "energy", "manual"] as const) {
      const out = applySort(tracks, s);
      expect(new Set(out.map((t) => t.uri))).toEqual(new Set(["a", "b", "c"]));
      expect(out).toHaveLength(3);
    }
  });
  it("puts unknown-energy tracks last under energy sort", () => {
    const mixed = [track({ uri: "x", energy: null }), track({ uri: "y", energy: 0.5 })];
    expect(applySort(mixed, "energy").map((t) => t.uri)).toEqual(["y", "x"]);
  });
});

describe("energyCurveOrder", () => {
  it("builds to a peak in the middle then comes down", () => {
    const tracks = [0.1, 0.9, 0.5, 0.3, 0.7].map((e, i) => track({ uri: `t${i}`, energy: e }));
    const energies = energyCurveOrder(tracks).map((t) => t.energy);
    const peakIdx = energies.indexOf(Math.max(...(energies as number[])));
    // The highest energy should sit at or near the centre, not at an edge.
    expect(peakIdx).toBeGreaterThan(0);
    expect(peakIdx).toBeLessThan(energies.length - 1);
    // Rises to the peak…
    for (let i = 1; i <= peakIdx; i++) expect(energies[i]!).toBeGreaterThanOrEqual(energies[i - 1]!);
    // …then falls.
    for (let i = peakIdx + 1; i < energies.length; i++) expect(energies[i]!).toBeLessThanOrEqual(energies[i - 1]!);
  });
  it("keeps tracks without energy at the end", () => {
    const tracks = [track({ uri: "a", energy: 0.5 }), track({ uri: "b", energy: null })];
    const ordered = energyCurveOrder(tracks);
    expect(ordered[ordered.length - 1].uri).toBe("b");
  });
});

describe("smoothCurveOrder", () => {
  it("forms an energy hump (middle hotter than the edges) and keeps every track", () => {
    const tracks = [0.1, 0.9, 0.5, 0.3, 0.7, 0.2, 0.6].map((e, i) =>
      track({ uri: `t${i}`, energy: e, bpm: 120 + e * 20, camelot: "8A" }),
    );
    const out = smoothCurveOrder(tracks);
    expect(new Set(out.map((t) => t.uri)).size).toBe(tracks.length);
    const energies = out.map((t) => t.energy as number);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const third = Math.floor(energies.length / 3);
    const middle = avg(energies.slice(third, energies.length - third));
    const edges = avg([...energies.slice(0, third), ...energies.slice(energies.length - third)]);
    expect(middle).toBeGreaterThan(edges); // warm-up → peak → cool-down
    expect(energies[0]).toBeLessThan(Math.max(...energies)); // starts below the peak
  });
  it("keeps tracks without energy at the end", () => {
    const tracks = [
      track({ uri: "a", energy: 0.4 }),
      track({ uri: "b", energy: 0.8 }),
      track({ uri: "c", energy: 0.2 }),
      track({ uri: "x", energy: null }),
    ];
    const out = smoothCurveOrder(tracks);
    expect(out[out.length - 1].uri).toBe("x");
  });
});

describe("smoothDanceOrder", () => {
  it("ramps danceability upward, ending on the most danceable, keeping every track", () => {
    const tracks = [0.2, 0.9, 0.5, 0.3, 0.7, 0.1, 0.6].map((d, i) =>
      track({ uri: `t${i}`, danceability: d, bpm: 120 + d * 20, camelot: "8A", energy: d }),
    );
    const out = smoothDanceOrder(tracks);
    expect(new Set(out.map((t) => t.uri)).size).toBe(tracks.length);
    const dances = out.map((t) => t.danceability as number);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const third = Math.floor(dances.length / 3);
    const first = avg(dances.slice(0, third));
    const last = avg(dances.slice(dances.length - third));
    expect(last).toBeGreaterThan(first); // builds from less to more danceable
    expect(dances[dances.length - 1]).toBe(Math.max(...dances)); // peak sits at the end
  });
  it("keeps tracks without danceability at the end", () => {
    const tracks = [
      track({ uri: "a", danceability: 0.4 }),
      track({ uri: "b", danceability: 0.8 }),
      track({ uri: "c", danceability: 0.2 }),
      track({ uri: "x", danceability: null }),
    ];
    const out = smoothDanceOrder(tracks);
    expect(out[out.length - 1].uri).toBe("x");
  });
});

describe("vibeGroups", () => {
  it("groups by mood", () => {
    const tracks = [
      track({ uri: "a", mood: "happy" }),
      track({ uri: "b", mood: "happy" }),
      track({ uri: "c", mood: "sad" }),
    ];
    const groups = vibeGroups(tracks, "mood");
    expect(groups[0].label).toBe("happy");
    expect(groups[0].tracks).toHaveLength(2);
  });
  it("splits energy×valence into quadrants", () => {
    const tracks = [
      track({ uri: "peak", energy: 0.8, valence: 0.8 }),
      track({ uri: "mellow", energy: 0.2, valence: 0.2 }),
    ];
    const keys = vibeGroups(tracks, "energyValence").map((g) => g.key);
    expect(keys).toContain("peak");
    expect(keys).toContain("mellow");
  });
  it("puts Greek tracks in the Greek party card", () => {
    const tracks = [track({ uri: "g", greek: true }), track({ uri: "i", greek: false, energy: 0.9, danceability: 0.9 })];
    const groups = vibeGroups(tracks, "party");
    const greek = groups.find((g) => g.key === "party-greek");
    expect(greek?.tracks.map((t) => t.uri)).toEqual(["g"]);
  });
});

describe("totalDurationMs", () => {
  it("sums durations, treating null as zero", () => {
    const tracks = [track({ uri: "a", durationMs: 1000 }), track({ uri: "b", durationMs: null }), track({ uri: "c", durationMs: 500 })];
    expect(totalDurationMs(tracks)).toBe(1500);
  });
});
