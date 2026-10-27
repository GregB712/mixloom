import type { Track } from "../api/client";

// --------------------------------------------------------------------------- //
// Camelot (harmonic mixing) helpers                                            //
// --------------------------------------------------------------------------- //
type Camelot = { n: number; letter: "A" | "B" };

export function parseCamelot(value: string | null): Camelot | null {
  if (!value) return null;
  const m = value.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, letter: m[2] as "A" | "B" };
}

// 0 = identical, small = compatible mix, large = clash. Based on the Camelot
// wheel: same key, relative major/minor (same number), and +/-1 along the wheel
// are the classic smooth moves.
export function camelotDistance(a: string | null, b: string | null): number {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 2.5; // unknown key: neutral-ish penalty
  const numDist = Math.min(Math.abs(pa.n - pb.n), 12 - Math.abs(pa.n - pb.n));
  const letterDiffers = pa.letter !== pb.letter;
  if (numDist === 0) return letterDiffers ? 0.5 : 0;
  if (numDist === 1 && !letterDiffers) return 1;
  return numDist + (letterDiffers ? 1.5 : 0);
}

// --------------------------------------------------------------------------- //
// Transition cost + smooth ordering (greedy nearest-neighbour)                 //
// --------------------------------------------------------------------------- //
function transitionCost(a: Track, b: Track): number {
  const camelot = camelotDistance(a.camelot, b.camelot);
  const bpm = a.bpm !== null && b.bpm !== null ? Math.abs(a.bpm - b.bpm) : 18;
  const energy = a.energy !== null && b.energy !== null ? Math.abs(a.energy - b.energy) : 0.3;
  return camelot * 2 + bpm * 0.12 + energy * 4;
}

// Rate a single transition for the UI: how smooth A -> B is.
export type MixQuality = "great" | "ok" | "jump";
export function mixQuality(a: Track, b: Track): MixQuality {
  const cost = transitionCost(a, b);
  if (cost <= 1.5) return "great";
  if (cost <= 3.5) return "ok";
  return "jump";
}

function orderByNumber(tracks: Track[], pick: (t: Track) => number | null): Track[] {
  return [...tracks].sort((x, y) => {
    const a = pick(x);
    const b = pick(y);
    if (a === null && b === null) return 0;
    if (a === null) return 1; // unknowns last
    if (b === null) return -1;
    return a - b;
  });
}

// Greedy "smoothest next track" ordering, starting from the lowest-energy track
// so the set tends to build upward.
export function smoothOrder(tracks: Track[]): Track[] {
  if (tracks.length <= 2) return [...tracks];
  const remaining = [...tracks];

  let startIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    const e = remaining[i].energy ?? remaining[i].bpm ?? Infinity;
    const best = remaining[startIdx].energy ?? remaining[startIdx].bpm ?? Infinity;
    if (e < best) startIdx = i;
  }

  const result: Track[] = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length) {
    const last = result[result.length - 1];
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cost = transitionCost(last, remaining[i]);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    result.push(remaining.splice(bestIdx, 1)[0]);
  }
  return result;
}

// Order toward an energy "mountain": a warm-up that rises to a mid-set peak,
// then a cool-down. Tracks are sorted by energy, then placed from the outer
// ends inward so the lowest-energy tracks bookend the set and the highest sits
// in the middle. Tracks without an energy value trail at the end.
export function energyCurveOrder(tracks: Track[]): Track[] {
  const withE = tracks.filter((t) => t.energy !== null);
  const without = tracks.filter((t) => t.energy === null);
  const sorted = orderByNumber(withE, (t) => t.energy);
  const n = sorted.length;
  const result = new Array<Track>(n);
  let lo = 0;
  let hi = n - 1;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) result[lo++] = sorted[i];
    else result[hi--] = sorted[i];
  }
  return [...result, ...without];
}

// How hard the combined ordering pulls toward the target energy curve, relative
// to the transition cost. It must outweigh the transition term enough that the
// arc (warm-up → peak → cool-down) actually forms instead of collapsing into a
// gentle ramp; transition cost then smooths the ordering among energy-similar
// candidates.
const CURVE_ENERGY_WEIGHT = 8;

// Combine the energy curve with smooth transitions: walk a target energy arc
// (warm-up → mid-set peak → cool-down) and, at each step, pick the remaining
// track that best balances a smooth transition from the previous track against
// closeness to the arc's target energy at that position. Tracks without an
// energy value trail at the end.
export function smoothCurveOrder(tracks: Track[]): Track[] {
  const withE = tracks.filter((t) => t.energy !== null);
  const without = tracks.filter((t) => t.energy === null);
  const n = withE.length;
  if (n <= 2) return [...withE, ...without];

  const energies = withE.map((t) => t.energy as number);
  const lo = Math.min(...energies);
  const hi = Math.max(...energies);
  const peak = Math.floor((n - 1) / 2); // position of the arc's peak
  const targetAt = (i: number): number => {
    const frac = i <= peak ? (peak === 0 ? 1 : i / peak) : 1 - (i - peak) / (n - 1 - peak);
    return lo + frac * (hi - lo);
  };

  const remaining = [...withE];
  const result: Track[] = [];
  for (let i = 0; i < n; i++) {
    const target = targetAt(i);
    const last = result.length ? result[result.length - 1] : null;
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let j = 0; j < remaining.length; j++) {
      const cand = remaining[j];
      const energyMiss = Math.abs((cand.energy as number) - target);
      const trans = last ? transitionCost(last, cand) : 0;
      const cost = trans + energyMiss * CURVE_ENERGY_WEIGHT;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = j;
      }
    }
    result.push(remaining.splice(bestIdx, 1)[0]);
  }
  return [...result, ...without];
}

export type SortStrategy = "smooth" | "curve" | "smoothCurve" | "bpm" | "energy" | "manual";

export function applySort(tracks: Track[], strategy: SortStrategy): Track[] {
  switch (strategy) {
    case "smooth":
      return smoothOrder(tracks);
    case "curve":
      return energyCurveOrder(tracks);
    case "smoothCurve":
      return smoothCurveOrder(tracks);
    case "bpm":
      return orderByNumber(tracks, (t) => t.bpm);
    case "energy":
      return orderByNumber(tracks, (t) => t.energy);
    default:
      return [...tracks];
  }
}

// --------------------------------------------------------------------------- //
// Vibe grouping                                                                //
// --------------------------------------------------------------------------- //
export type VibeScheme = "energyValence" | "bpm" | "party" | "mood" | "genre";
export type VibeGroup = { key: string; label: string; description: string; tracks: Track[] };

export const VIBE_SCHEMES: { value: VibeScheme; label: string; needs: "ev" | "bpm" | "mood" | "genre" }[] = [
  { value: "energyValence", label: "Energy × mood (quadrants)", needs: "ev" },
  { value: "bpm", label: "Tempo bands (BPM)", needs: "bpm" },
  { value: "party", label: "Partying (Greek / non-Greek)", needs: "ev" },
  { value: "mood", label: "FreqBlog mood", needs: "mood" },
  { value: "genre", label: "Genre", needs: "genre" },
];

function byField(tracks: Track[], pick: (t: Track) => string | null): VibeGroup[] {
  const map = new Map<string, Track[]>();
  for (const t of tracks) {
    const v = pick(t);
    if (!v) continue;
    const bucket = map.get(v) ?? [];
    bucket.push(t);
    map.set(v, bucket);
  }
  return [...map.entries()]
    .map(([key, ts]) => ({ key, label: key, description: `${ts.length} tracks`, tracks: ts }))
    .sort((a, b) => b.tracks.length - a.tracks.length);
}

export function vibeGroups(tracks: Track[], scheme: VibeScheme): VibeGroup[] {
  if (scheme === "mood") return byField(tracks, (t) => t.mood);
  if (scheme === "genre") return byField(tracks, (t) => t.genre);

  if (scheme === "bpm") {
    const bands: { key: string; label: string; test: (b: number) => boolean }[] = [
      { key: "warmup", label: "Warm-up · under 110", test: (b) => b < 110 },
      { key: "groove", label: "Groove · 110–123", test: (b) => b >= 110 && b < 124 },
      { key: "peak", label: "Peak · 124–129", test: (b) => b >= 124 && b < 130 },
      { key: "high", label: "High-energy · 130+", test: (b) => b >= 130 },
    ];
    return bands
      .map((band) => ({
        key: band.key,
        label: band.label,
        tracks: tracks.filter((t) => t.bpm !== null && band.test(t.bpm)),
      }))
      .filter((g) => g.tracks.length > 0)
      .map((g) => ({ ...g, description: `${g.tracks.length} tracks` }));
  }

  if (scheme === "party") {
    // Greek card: every Greek track (their audio features are mostly missing, so
    // no danceability/energy filter). Non-Greek card: danceable, energetic tracks.
    const isParty = (t: Track) =>
      t.energy !== null && t.danceability !== null && t.energy >= 0.6 && t.danceability >= 0.6;
    return [
      {
        key: "party-greek",
        label: "Partying · Greek",
        description: "all Greek tracks",
        tracks: tracks.filter((t) => t.greek),
      },
      {
        key: "party-intl",
        label: "Partying · Non-Greek",
        description: "danceable & energetic · international",
        tracks: tracks.filter((t) => !t.greek && isParty(t)),
      },
    ].filter((g) => g.tracks.length > 0);
  }

  // energy × valence quadrants (both features required)
  const quads: { key: string; label: string; description: string; test: (e: number, v: number) => boolean }[] = [
    { key: "peak", label: "Peak · Euphoric", description: "high energy · bright", test: (e, v) => e >= 0.5 && v >= 0.5 },
    { key: "sunny", label: "Sunny · Chill", description: "easy energy · bright", test: (e, v) => e < 0.5 && v >= 0.5 },
    { key: "dark", label: "Dark · Driving", description: "high energy · moody", test: (e, v) => e >= 0.5 && v < 0.5 },
    { key: "mellow", label: "Mellow · Introspective", description: "low energy · moody", test: (e, v) => e < 0.5 && v < 0.5 },
  ];
  return quads
    .map((q) => ({
      key: q.key,
      label: q.label,
      description: q.description,
      tracks: tracks.filter((t) => t.energy !== null && t.valence !== null && q.test(t.energy, t.valence)),
    }))
    .filter((g) => g.tracks.length > 0);
}

export function totalDurationMs(tracks: Track[]): number {
  return tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
}
