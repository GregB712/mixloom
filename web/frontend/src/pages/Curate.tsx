import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthStatus, type EnvFlags, type PlaylistInfo, type SavedFilter, type Track } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { LogPanel } from "../components/ui/LogPanel";
import { MultiSelect } from "../components/ui/MultiSelect";
import { Select } from "../components/ui/Select";
import { Tabs } from "../components/ui/Tabs";
import { TrackArt } from "../components/ui/TrackArt";
import { useToast } from "../components/ui/Toast";
import { useJobStream } from "../hooks/useJobStream";
import { usePlayback } from "../hooks/usePlayback";
import { formatDuration } from "../lib/format";
import {
  applySort,
  mixQuality,
  totalDurationMs,
  vibeGroups,
  VIBE_SCHEMES,
  type SortStrategy,
  type VibeScheme,
} from "../lib/curate";

const SORT_OPTIONS = [
  { value: "smooth", label: "Smooth transitions (key + tempo + energy)" },
  { value: "curve", label: "Energy curve (warm-up → peak → cool-down)" },
  { value: "smoothCurve", label: "Energy curve + smooth transitions" },
  { value: "smoothDance", label: "Danceability ramp + smooth transitions" },
  { value: "bpm", label: "BPM ascending" },
  { value: "energy", label: "Energy ascending" },
  { value: "manual", label: "Selection order" },
];

function trackSeconds(ms: number | null): string {
  if (ms === null) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Curate({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const [source, setSource] = useState<string[]>([]);

  if (playlists.isLoading) return <p className="muted">Loading playlists…</p>;
  if ((playlists.data ?? []).length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon="🎚️" title="No playlists to curate yet">
            Export playlists in the <strong>Run pipeline</strong> tab first, then enrich them so you
            have metadata to build with.
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  return <CurateBody env={env} auth={auth} source={source} playlists={playlists.data ?? []} onSource={setSource} />;
}

function CurateBody({
  env,
  auth,
  source,
  playlists,
  onSource,
}: {
  env: EnvFlags;
  auth: AuthStatus;
  source: string[];
  playlists: PlaylistInfo[];
  onSource: (value: string[]) => void;
}) {
  const playlistIds = source.map(Number);
  const sourceKey = [...source].sort().join(",");
  const pool = useQuery({ queryKey: ["curate", sourceKey], queryFn: () => api.curateTracks(playlistIds) });
  const [selected, setSelected] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<SortStrategy>("smooth");
  // Undo history of the working selection (each edit snapshots the prior list).
  const [history, setHistory] = useState<string[][]>([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pushHistory = () => setHistory((h) => [...h, selectedRef.current]);
  const undo = () =>
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelected(h[h.length - 1]);
      return h.slice(0, -1);
    });

  // When set, the builder is editing an existing curated playlist in place
  // (save writes back to it) rather than creating a brand-new one.
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const skipReset = useRef(false);

  // Reset the working set when the source changes (unless we just loaded an
  // existing curated playlist, which deliberately sets the source).
  useEffect(() => {
    if (skipReset.current) { skipReset.current = false; return; }
    setSelected([]); setHistory([]); setEditing(null);
  }, [sourceKey]);

  // Load a curated playlist's tracks into the builder to edit and save back.
  const openCurated = async (pl: PlaylistInfo) => {
    const tracks = await api.playlistTracks(pl.id);
    if (source.length) { skipReset.current = true; onSource([]); } // whole library resolves its tracks
    setSelected(tracks.map((t) => t.uri));
    setHistory([]);
    setEditing({ id: pl.id, name: pl.name });
  };

  // With several playlists combined, the same song can appear under different
  // Spotify URIs (single vs. album version). Collapse those by title + artist,
  // keeping the first occurrence.
  const rawTracks = pool.data?.tracks ?? [];
  const tracks = useMemo(() => {
    if (playlistIds.length <= 1) return rawTracks;
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const t of rawTracks) {
      const key = `${t.title} — ${t.artists}`.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [rawTracks, playlistIds.length]);
  const dupCount = rawTracks.length - tracks.length;
  const byUri = useMemo(() => new Map(tracks.map((t) => [t.uri, t])), [tracks]);
  const selectedTracks = useMemo(
    () => selected.map((u) => byUri.get(u)).filter((t): t is Track => !!t),
    [selected, byUri],
  );

  const addUris = (uris: string[], replace = false) => {
    pushHistory();
    setSelected((prev) => {
      const base = replace ? [] : prev;
      const seen = new Set(base);
      const next = [...base];
      for (const u of uris) if (!seen.has(u)) { seen.add(u); next.push(u); }
      return next;
    });
  };
  const removeUris = (uris: string[]) => {
    pushHistory();
    const drop = new Set(uris);
    setSelected((prev) => prev.filter((u) => !drop.has(u)));
  };
  const reorder = (s: SortStrategy) => {
    pushHistory();
    setStrategy(s);
    setSelected(applySort(selectedTracks, s).map((t) => t.uri));
  };
  // Hand reorder via drag-and-drop; the order becomes the manual selection order.
  const moveTrack = (from: number, to: number) => {
    if (from === to) return;
    pushHistory();
    setSelected((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setStrategy("manual");
  };
  const clearSelection = () => { pushHistory(); setSelected([]); };

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Pick a source" subtitle="Build from one or more playlists you already exported (none = all)" />
        <CardBody>
          <div className="row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
            <div style={{ flex: 1, minWidth: 260, maxWidth: 520 }}>
              <MultiSelect
                label="Source playlists (track pool · none = all)"
                options={playlists.map((p) => ({
                  value: String(p.id),
                  label: `${p.curated ? "★ " : ""}${p.name}`,
                  meta: `${p.trackCount} tracks`,
                }))}
                selected={source}
                onChange={onSource}
              />
            </div>
            {pool.data && (
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <Badge tone="accent">{tracks.length} usable tracks</Badge>
                {dupCount > 0 && <Badge tone="warn">{dupCount} duplicate{dupCount > 1 ? "s" : ""} removed</Badge>}
                {pool.data.hasFeatures ? <Badge tone="ok">audio features</Badge> : <Badge tone="warn">no features</Badge>}
              </div>
            )}
          </div>
          {pool.data && pool.data.hasUris && !pool.data.hasFeatures && (
            <Callout tone="warn">
              No audio features in this pool. You can still pick tracks manually, but vibe grouping and
              smooth-transition sorting need the audio-feature enrichment step.
            </Callout>
          )}
          {playlists.some((p) => p.curated) && (
            <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
              <span className="small faint">Edit an existing curated playlist:</span>
              {playlists.filter((p) => p.curated).map((p) => (
                <Button
                  key={p.id}
                  variant={editing?.id === p.id ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => openCurated(p)}
                >
                  ★ {p.name}
                </Button>
              ))}
            </div>
          )}
          {editing && (
            <Callout tone="ok">
              Editing <code>{editing.name}</code> in place — saving writes changes back to it.
            </Callout>
          )}
        </CardBody>
      </Card>

      {pool.isLoading && <p className="muted">Loading tracks…</p>}
      {pool.data && pool.data.hasUris && (
        <>
          <BuildCard pool={tracks} hasFeatures={pool.data.hasFeatures} selected={selected} addUris={addUris} removeUris={removeUris} />
          <PlaylistCard
            env={env}
            auth={auth}
            selectedTracks={selectedTracks}
            strategy={strategy}
            canUndo={history.length > 0}
            onUndo={undo}
            onStrategy={reorder}
            onReapply={() => reorder(strategy)}
            onRemove={(u) => removeUris([u])}
            onClear={clearSelection}
            onMove={moveTrack}
            onAdd={addUris}
          />
          <CreateCard
            env={env}
            auth={auth}
            selected={selected}
            selectedTracks={selectedTracks}
            editing={editing}
            playlists={playlists}
          />
        </>
      )}
    </div>
  );
}

// -------- Build: manual picker + vibe generator ----------------------------- //
function BuildCard({
  pool,
  hasFeatures,
  selected,
  addUris,
  removeUris,
}: {
  pool: Track[];
  hasFeatures: boolean;
  selected: string[];
  addUris: (uris: string[], replace?: boolean) => void;
  removeUris: (uris: string[]) => void;
}) {
  const [mode, setMode] = useState("manual");
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <Card>
      <CardHeader
        title="Build the playlist"
        subtitle="Choose tracks by hand, or generate a set by vibe"
        right={
          <Tabs
            items={[{ id: "manual", label: "Pick manually" }, { id: "vibe", label: "Auto by vibe" }]}
            active={mode}
            onChange={setMode}
          />
        }
      />
      <CardBody>
        {mode === "manual" ? (
          <ManualPicker pool={pool} selectedSet={selectedSet} addUris={addUris} removeUris={removeUris} />
        ) : (
          <VibePicker pool={pool} hasFeatures={hasFeatures} addUris={addUris} />
        )}
      </CardBody>
    </Card>
  );
}

// Categorical (dropdown) and numeric (min/max range) filters, one per metadata field.
const CAT_FILTERS: { key: string; label: string; get: (t: Track) => string | null }[] = [
  { key: "genre", label: "Genre", get: (t) => t.genre },
  { key: "mood", label: "Mood", get: (t) => t.mood },
  { key: "camelot", label: "Key (Camelot)", get: (t) => t.camelot },
  { key: "musicalKey", label: "Musical key", get: (t) => t.musicalKey },
];
const RANGE_FILTERS: { key: string; label: string; get: (t: Track) => number | null; step: number }[] = [
  { key: "bpm", label: "BPM", get: (t) => t.bpm, step: 1 },
  { key: "energy", label: "Energy", get: (t) => t.energy, step: 0.05 },
  { key: "valence", label: "Valence", get: (t) => t.valence, step: 0.05 },
  { key: "danceability", label: "Danceability", get: (t) => t.danceability, step: 0.05 },
  { key: "acousticness", label: "Acousticness", get: (t) => t.acousticness, step: 0.05 },
  { key: "durationSec", label: "Duration (s)", get: (t) => (t.durationMs !== null ? t.durationMs / 1000 : null), step: 5 },
];

function ManualPicker({
  pool,
  selectedSet,
  addUris,
  removeUris,
}: {
  pool: Track[];
  selectedSet: Set<string>;
  addUris: (uris: string[], replace?: boolean) => void;
  removeUris: (uris: string[]) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [album, setAlbum] = useState("");
  const [greek, setGreek] = useState("");
  const [cats, setCats] = useState<Record<string, string>>({});
  const [ranges, setRanges] = useState<Record<string, { min: string; max: string }>>({});

  const setRange = (key: string, which: "min" | "max", value: string) =>
    setRanges((p) => {
      const cur = p[key] ?? { min: "", max: "" };
      return { ...p, [key]: { ...cur, [which]: value } };
    });
  const reset = () => { setSearch(""); setAlbum(""); setGreek(""); setCats({}); setRanges({}); };

  // Saved filters ("smart playlists"): persist and re-apply the filter rules.
  const savedFilters = useQuery({ queryKey: ["savedFilters"], queryFn: api.savedFilters });
  const applyRules = (rules: Record<string, unknown>) => {
    setSearch((rules.search as string) ?? "");
    setAlbum((rules.album as string) ?? "");
    setGreek((rules.greek as string) ?? "");
    setCats((rules.cats as Record<string, string>) ?? {});
    setRanges((rules.ranges as Record<string, { min: string; max: string }>) ?? {});
  };
  const currentRules = () => ({ search, album, greek, cats, ranges });
  const saveFilterMut = useMutation({
    mutationFn: (name: string) => api.saveFilter(name, currentRules()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["savedFilters"] }); toast.notify("Filter saved."); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });
  const deleteFilterMut = useMutation({
    mutationFn: (id: number) => api.deleteFilter(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["savedFilters"] }); toast.notify("Filter deleted."); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });
  const saveCurrentFilter = () => {
    const name = window.prompt("Name this filter (e.g. \"Greek · 124–129 BPM\")")?.trim();
    if (name) saveFilterMut.mutate(name);
  };

  // Distinct values present in the current pool, per categorical field.
  const catOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of CAT_FILTERS) {
      out[f.key] = [...new Set(pool.map(f.get).filter((v): v is string => !!v))].sort();
    }
    return out;
  }, [pool]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const alb = album.trim().toLowerCase();
    return pool.filter((t) => {
      if (q && !`${t.title} ${t.artists}`.toLowerCase().includes(q)) return false;
      if (alb && !(t.album || "").toLowerCase().includes(alb)) return false;
      if (greek === "greek" && !t.greek) return false;
      if (greek === "nongreek" && t.greek) return false;
      for (const f of CAT_FILTERS) {
        if (cats[f.key] && f.get(t) !== cats[f.key]) return false;
      }
      for (const f of RANGE_FILTERS) {
        const r = ranges[f.key];
        if (!r) continue;
        const v = f.get(t);
        if (r.min !== "" && (v === null || v < Number(r.min))) return false;
        if (r.max !== "" && (v === null || v > Number(r.max))) return false;
      }
      return true;
    });
  }, [pool, search, album, greek, cats, ranges]);

  const filteredUris = filtered.map((t) => t.uri);

  const savedList = savedFilters.data ?? [];
  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-2)" }}>
        <div className="row" style={{ gap: "var(--space-2)", flex: 1, minWidth: 0 }}>
          <span className="small faint">Saved filters:</span>
          {savedList.length === 0 && <span className="small muted">none yet</span>}
          {savedList.map((f: SavedFilter) => (
            <span key={f.id} className="badge" style={{ gap: "var(--space-1)" }}>
              <button
                className="badge__btn"
                onClick={() => applyRules(f.rules)}
                title="Apply this filter"
              >{f.name}</button>
              <button
                className="badge__btn badge__btn--x"
                onClick={() => deleteFilterMut.mutate(f.id)}
                aria-label={`Delete filter ${f.name}`}
              >✕</button>
            </span>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={saveCurrentFilter} loading={saveFilterMut.isPending}>
          Save current filters
        </Button>
      </div>
      <div className="row">
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Search title or artist…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Album contains…" value={album} onChange={(e) => setAlbum(e.target.value)} />
        <div style={{ minWidth: 130 }}>
          <Select
            value={greek}
            options={[{ value: "", label: "Greek: any" }, { value: "greek", label: "Greek only" }, { value: "nongreek", label: "Non-Greek only" }]}
            onChange={setGreek}
          />
        </div>
      </div>
      <div className="row">
        {CAT_FILTERS.filter((f) => catOptions[f.key].length > 0).map((f) => (
          <div key={f.key} style={{ minWidth: 150, flex: 1 }}>
            <Select
              value={cats[f.key] ?? ""}
              options={[{ value: "", label: `All ${f.label.toLowerCase()}` }, ...catOptions[f.key].map((v) => ({ value: v, label: v }))]}
              onChange={(v) => setCats((p) => ({ ...p, [f.key]: v }))}
            />
          </div>
        ))}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
        {RANGE_FILTERS.map((f) => (
          <div key={f.key} className="field" style={{ gap: 2 }}>
            <label className="small faint">{f.label}</label>
            <div className="row" style={{ gap: 4 }}>
              <input className="input" style={{ width: 70 }} placeholder="min" inputMode="decimal" step={f.step}
                value={ranges[f.key]?.min ?? ""} onChange={(e) => setRange(f.key, "min", e.target.value)} />
              <input className="input" style={{ width: 70 }} placeholder="max" inputMode="decimal" step={f.step}
                value={ranges[f.key]?.max ?? ""} onChange={(e) => setRange(f.key, "max", e.target.value)} />
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small faint">{filtered.length} of {pool.length} tracks</span>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <Button variant="ghost" size="sm" onClick={reset}>Reset filters</Button>
          <Button variant="secondary" size="sm" onClick={() => addUris(filteredUris)}>Add all filtered</Button>
          <Button variant="ghost" size="sm" onClick={() => removeUris(filteredUris)}>Remove filtered</Button>
        </div>
      </div>
      <div className="multiselect__box" style={{ maxHeight: 360 }}>
        {filtered.slice(0, 600).map((t) => (
          <label className="option" key={t.uri}>
            <input
              type="checkbox"
              checked={selectedSet.has(t.uri)}
              onChange={(e) => (e.target.checked ? addUris([t.uri]) : removeUris([t.uri]))}
            />
            <TrackArt url={t.albumArt} size={32} />
            <span className="option__name">
              <strong>{t.title || "(untitled)"}</strong>
              <span className="muted"> — {t.artists}</span>
            </span>
            <TrackChips track={t} />
          </label>
        ))}
        {filtered.length === 0 && <div className="option muted">No tracks match these filters.</div>}
      </div>
      {filtered.length > 600 && <span className="small faint">Showing first 600; refine filters to see the rest.</span>}
    </div>
  );
}

function VibePicker({
  pool,
  hasFeatures,
  addUris,
}: {
  pool: Track[];
  hasFeatures: boolean;
  addUris: (uris: string[], replace?: boolean) => void;
}) {
  const [scheme, setScheme] = useState<VibeScheme>("energyValence");
  const groups = useMemo(() => vibeGroups(pool, scheme), [pool, scheme]);
  const needsFeatures = scheme === "energyValence" || scheme === "bpm" || scheme === "party";

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div style={{ maxWidth: 320 }}>
        <Select
          label="Group by"
          value={scheme}
          options={VIBE_SCHEMES.map((s) => ({ value: s.value, label: s.label }))}
          onChange={(v) => setScheme(v as VibeScheme)}
        />
      </div>
      {needsFeatures && !hasFeatures ? (
        <Callout tone="warn">This grouping needs audio features. Run the audio-feature enrichment first.</Callout>
      ) : groups.length === 0 ? (
        <Callout>No groups available for this scheme in the current pool.</Callout>
      ) : (
        <div className="grid cols-2">
          {groups.map((g) => (
            <Card key={g.key}>
              <CardBody style={{ gap: "var(--space-2)" }}>
                <div className="chartcard__title">
                  <span>{g.label}</span>
                  <Badge>{g.tracks.length}</Badge>
                </div>
                <span className="small faint">{g.description}</span>
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <Button size="sm" onClick={() => addUris(g.tracks.map((t) => t.uri), true)}>Use these</Button>
                  <Button variant="secondary" size="sm" onClick={() => addUris(g.tracks.map((t) => t.uri))}>+ Add</Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// -------- Playlist preview + ordering --------------------------------------- //
function PlaylistCard({
  env,
  auth,
  selectedTracks,
  strategy,
  canUndo,
  onUndo,
  onStrategy,
  onReapply,
  onRemove,
  onClear,
  onMove,
  onAdd,
}: {
  env: EnvFlags;
  auth: AuthStatus;
  selectedTracks: Track[];
  strategy: SortStrategy;
  canUndo: boolean;
  onUndo: () => void;
  onStrategy: (s: SortStrategy) => void;
  onReapply: () => void;
  onRemove: (uri: string) => void;
  onClear: () => void;
  onMove: (from: number, to: number) => void;
  onAdd: (uris: string[]) => void;
}) {
  const toast = useToast();
  const duration = totalDurationMs(selectedTracks);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // Which track's "similar" drawer is open (by URI), if any.
  const [similarFor, setSimilarFor] = useState<string | null>(null);
  const selectedUris = useMemo(() => new Set(selectedTracks.map((t) => t.uri)), [selectedTracks]);

  // Play the built playlist in its current order via the shared Web Playback
  // controller (same engine as the Player tab).
  const canPlay = env.spotify && auth.player;
  const pb = usePlayback(canPlay);
  const uris = useMemo(() => selectedTracks.map((t) => t.uri), [selectedTracks]);
  const currentUri = pb.current?.uri ?? null;
  const playFrom = async (index: number) => {
    try {
      await pb.play(uris, index);
    } catch (e) {
      toast.notify((e as Error).message, "danger");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Your playlist"
        subtitle={`${selectedTracks.length} tracks · ${formatDuration(duration)}`}
        right={
          selectedTracks.length > 0 ? (
            <div className="row" style={{ gap: "var(--space-2)" }}>
              {canPlay && <Button size="sm" onClick={() => playFrom(0)}>▶ Play all</Button>}
              <Button variant="ghost" size="sm" disabled={!canUndo} onClick={onUndo} aria-label="Undo last change">↶ Undo</Button>
              <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>
            </div>
          ) : undefined
        }
      />
      <CardBody>
        {selectedTracks.length === 0 ? (
          <EmptyState icon="➕" title="No tracks selected">Add tracks above, or generate a vibe.</EmptyState>
        ) : (
          <>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 260, maxWidth: 420 }}>
                <Select label="Order" value={strategy} options={SORT_OPTIONS} onChange={(v) => onStrategy(v as SortStrategy)} />
              </div>
              <Button variant="secondary" size="sm" onClick={onReapply}>Re-apply order</Button>
            </div>
            <div className="multiselect__box" style={{ maxHeight: 420 }}>
              {selectedTracks.map((t, i) => {
                const isCurrent = currentUri === t.uri;
                return (
                  <div
                    className="option"
                    key={t.uri}
                    draggable
                    onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIndex !== i) setOverIndex(i); }}
                    onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) onMove(dragIndex, i); setDragIndex(null); setOverIndex(null); }}
                    onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                    style={{
                      cursor: "grab",
                      opacity: dragIndex === i ? 0.4 : 1,
                      boxShadow:
                        overIndex === i && dragIndex !== null && dragIndex !== i
                          ? (i < dragIndex ? "inset 0 2px 0 0 var(--accent)" : "inset 0 -2px 0 0 var(--accent)")
                          : undefined,
                    }}
                  >
                    <span className="faint" aria-hidden style={{ userSelect: "none" }} title="Drag to reorder">⠿</span>
                    <MixDot prev={i > 0 ? selectedTracks[i - 1] : null} curr={t} />
                    <span className="faint small" style={{ width: 28, textAlign: "right" }}>{i + 1}</span>
                    <TrackArt url={t.albumArt} size={32} />
                    <span className="option__name">
                      <strong>{isCurrent ? "🔊 " : ""}{t.title || "(untitled)"}</strong>
                      <span className="muted"> — {t.artists}</span>
                    </span>
                    <TrackChips track={t} />
                    <button
                      className="btn btn--ghost btn--sm"
                      style={{ color: similarFor === t.uri ? "var(--brand)" : undefined }}
                      onClick={() => setSimilarFor((u) => (u === t.uri ? null : t.uri))}
                      aria-label={`Find tracks similar to ${t.title}`}
                      title="More like this"
                    >✨</button>
                    {canPlay && (
                      <button className="btn btn--ghost btn--sm" onClick={() => playFrom(i)} aria-label={`Play ${t.title}`}>▶</button>
                    )}
                    <button className="btn btn--ghost btn--sm" onClick={() => onRemove(t.uri)} aria-label="Remove">✕</button>
                  </div>
                );
              })}
            </div>
            {similarFor && (
              <SimilarDrawer
                seedUri={similarFor}
                selectedUris={selectedUris}
                onClose={() => setSimilarFor(null)}
                onAdd={(uris) => onAdd(uris)}
              />
            )}
            <span className="small faint">
              Drag <span aria-hidden>⠿</span> to reorder by hand. Dots show mix quality from the previous track:
              <span className="mix mix--great" /> smooth, <span className="mix mix--ok" /> ok, <span className="mix mix--jump" /> jump.
            </span>

            {!canPlay && (env.spotify ? (
              <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)", borderTop: "1px solid var(--border)", paddingTop: "var(--space-4)" }}>
                <span className="muted small">Connect the player to play these tracks here (needs Spotify Premium).</span>
                <Button size="sm" onClick={() => { window.location.href = api.loginUrl("player"); }}>Connect Spotify (player)</Button>
              </div>
            ) : (
              <span className="small faint" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--space-4)" }}>
                Set the SPOTIPY_* variables in <code>.env</code> to play tracks here.
              </span>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
}

// "More like this": nearest-neighbour tracks over the audio-feature vector,
// shown inline with add buttons. Powers "more like this" / auto-extend.
function SimilarDrawer({
  seedUri,
  selectedUris,
  onClose,
  onAdd,
}: {
  seedUri: string;
  selectedUris: Set<string>;
  onClose: () => void;
  onAdd: (uris: string[]) => void;
}) {
  const sim = useQuery({ queryKey: ["similar", seedUri], queryFn: () => api.similar(seedUri, 20) });
  const candidates = (sim.data?.tracks ?? []).filter((t) => !selectedUris.has(t.uri));

  return (
    <div className="stack" style={{ gap: "var(--space-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--space-3)", background: "var(--surface-2)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">More like this</span>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          {candidates.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => onAdd(candidates.map((t) => t.uri))}>
              + Add all {candidates.length}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close similar">✕</Button>
        </div>
      </div>
      {sim.isLoading && <span className="small faint">Finding similar tracks…</span>}
      {sim.isError && <Callout tone="danger">{(sim.error as Error).message}</Callout>}
      {sim.data && !sim.data.hasFeatures && (
        <Callout tone="warn">This track has no audio features, so similarity can't be computed. Run feature enrichment first.</Callout>
      )}
      {sim.data?.hasFeatures && candidates.length === 0 && (
        <span className="small faint">No more similar tracks to add.</span>
      )}
      {candidates.length > 0 && (
        <div className="multiselect__box" style={{ maxHeight: 260 }}>
          {candidates.map((t) => (
            <div className="option" key={t.uri}>
              <TrackArt url={t.albumArt} size={28} />
              <span className="option__name">
                <strong>{t.title || "(untitled)"}</strong>
                <span className="muted"> — {t.artists}</span>
              </span>
              <TrackChips track={t} />
              <button className="btn btn--ghost btn--sm" onClick={() => onAdd([t.uri])} aria-label={`Add ${t.title}`}>+ Add</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MixDot({ prev, curr }: { prev: Track | null; curr: Track }) {
  if (!prev) return <span style={{ width: 10 }} />;
  const q = mixQuality(prev, curr);
  return <span className={`mix mix--${q}`} title={`Transition: ${q}`} />;
}

function TrackChips({ track }: { track: Track }) {
  return (
    <span className="chips">
      {track.bpm !== null && <span className="chip">{Math.round(track.bpm)} BPM</span>}
      {track.camelot && <span className="chip chip--key">{track.camelot}</span>}
      {track.energy !== null && <span className="chip">E {track.energy.toFixed(2)}</span>}
      <span className="chip chip--muted">{trackSeconds(track.durationMs)}</span>
    </span>
  );
}

// -------- Create / save ----------------------------------------------------- //
function CreateCard({
  env,
  auth,
  selected,
  selectedTracks,
  editing,
  playlists,
}: {
  env: EnvFlags;
  auth: AuthStatus;
  selected: string[];
  selectedTracks: Track[];
  editing: { id: number; name: string } | null;
  playlists: PlaylistInfo[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const stream = useJobStream(jobId, (ok) => {
    toast.notify(ok ? "Playlist pushed to Spotify." : "Push to Spotify failed. See the log.", ok ? "ok" : "danger");
  });

  const editingInfo = editing ? playlists.find((p) => p.id === editing.id) : undefined;
  const editingHasSpotify = !!editingInfo?.spotifyPlaylistId;

  const refreshData = () => {
    qc.invalidateQueries({ queryKey: ["playlists"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
  };

  // --- Editing an existing curated playlist in place --------------------- //
  const updateMut = useMutation({
    mutationFn: () => api.updatePlaylistTracks(editing!.id, selected),
    onSuccess: (res) => { refreshData(); toast.notify(`Updated "${editing!.name}" (${res.count} tracks).`); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });
  const pushEditMut = useMutation({
    mutationFn: async () => {
      // Save edits to the DB first, then push (update in place if possible).
      await api.updatePlaylistTracks(editing!.id, selected);
      refreshData();
      const job = await api.createPlaylist(editing!.id, editing!.name, editingHasSpotify);
      return job.jobId;
    },
    onSuccess: (id) => { setJobId(id); refreshData(); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  // --- Creating a brand-new curated playlist ----------------------------- //
  const saveMut = useMutation({
    mutationFn: () => api.curateSave(name.trim(), selected),
    onSuccess: (res) => { setSavedName(res.name); refreshData(); toast.notify(`Saved "${res.name}" (${res.count} tracks).`); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });
  const createMut = useMutation({
    mutationFn: async () => {
      const saved = await api.curateSave(name.trim(), selected);
      setSavedName(saved.name);
      refreshData();
      const job = await api.createPlaylist(saved.playlistId, name.trim());
      return job.jobId;
    },
    onSuccess: (id) => setJobId(id),
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const empty = selectedTracks.length === 0;
  const pushBusy = jobId !== null && !stream.done;

  if (editing) {
    return (
      <Card>
        <CardHeader
          title={`Save changes to "${editing.name}"`}
          subtitle="You're editing an existing curated playlist in place"
        />
        <CardBody>
          <div className="row">
            <Button variant="secondary" disabled={empty} loading={updateMut.isPending} onClick={() => updateMut.mutate()}>
              Update playlist
            </Button>
            {env.spotify && auth.write && (
              <Button disabled={empty || pushEditMut.isPending || pushBusy} loading={pushEditMut.isPending || pushBusy} onClick={() => pushEditMut.mutate()}>
                {editingHasSpotify ? "Update on Spotify" : "Push to Spotify"}
              </Button>
            )}
            <span className="small faint">{selectedTracks.length} tracks in the shown order.</span>
          </div>
          {env.spotify && !auth.write && (
            <div className="row">
              <span className="muted small">Pushing to Spotify needs write access.</span>
              <Button size="sm" onClick={() => { window.location.href = api.loginUrl("write"); }}>Connect Spotify (write)</Button>
            </div>
          )}
          {jobId && <LogPanel lines={stream.lines} status={stream.status} />}
        </CardBody>
      </Card>
    );
  }

  const disabled = !name.trim() || empty;
  return (
    <Card>
      <CardHeader title="Save & create" subtitle="Save the curated playlist to the database, and optionally create it on Spotify in this order" />
      <CardBody>
        <div className="field" style={{ maxWidth: 420 }}>
          <label className="label" htmlFor="curate-name">Playlist name</label>
          <input id="curate-name" className="input" value={name} placeholder="e.g. Sunset Build-Up" onChange={(e) => setName(e.target.value)} />
        </div>

        {!env.spotify ? (
          <Callout tone="warn">Set the SPOTIPY_* variables in <code>.env</code> to create Spotify playlists. You can still save to the database.</Callout>
        ) : !auth.write ? (
          <div className="row">
            <span className="muted small">Creating on Spotify needs write access.</span>
            <Button onClick={() => { window.location.href = api.loginUrl("write"); }}>Connect Spotify (write)</Button>
          </div>
        ) : null}

        <div className="row">
          <Button variant="secondary" disabled={disabled} loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
            Save to database
          </Button>
          <Button disabled={disabled || !env.spotify || !auth.write} loading={pushBusy && createMut.isPending} onClick={() => createMut.mutate()}>
            Create Spotify playlist
          </Button>
          <span className="small faint">{selectedTracks.length} tracks will be added in the shown order.</span>
        </div>

        {savedName && !jobId && <Callout tone="ok">Saved <code>{savedName}</code> as a curated playlist in the database. It's now in the Dashboard and the create step.</Callout>}
        {jobId && <LogPanel lines={stream.lines} status={stream.status} />}
      </CardBody>
    </Card>
  );
}
