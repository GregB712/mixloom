import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TrackDetail } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { TrackArt } from "../components/ui/TrackArt";

const LIMIT = 50;

// Core fields define whether a track's metadata is "complete" (mirrors the
// backend CORE_FIELDS); their human labels are reused in the editor.
const CORE_FIELDS = ["bpm", "key", "camelot", "energy", "danceability", "valence", "genre", "mood"];

// Canonical dropdown lists. Keys use the enrichment pipeline's enharmonic
// spelling (sharps for C#/F#, flats for Bb/Eb/Ab); every one of the 24 keys is
// offered. The option shows the short abbreviation (major = root, minor =
// root+"m") but stores the long form the rest of the library uses, e.g. "C#m"
// is saved as "C#-Minor". Camelot is the full wheel.
type Opt = { value: string; label: string };
// Each root stores one canonical spelling (what the pipeline writes) but is
// labelled with both enharmonic names for the black keys, so sharps like G#
// are visible even though the value is kept as Ab.
const KEY_ROOTS: { value: string; abbr: string }[] = [
  { value: "A", abbr: "A" },
  { value: "Bb", abbr: "Bb/A#" },
  { value: "B", abbr: "B" },
  { value: "C", abbr: "C" },
  { value: "C#", abbr: "C#/Db" },
  { value: "D", abbr: "D" },
  { value: "Eb", abbr: "Eb/D#" },
  { value: "E", abbr: "E" },
  { value: "F", abbr: "F" },
  { value: "F#", abbr: "F#/Gb" },
  { value: "G", abbr: "G" },
  { value: "Ab", abbr: "Ab/G#" },
];
const KEY_OPTIONS: Opt[] = KEY_ROOTS.flatMap((r) => [
  { value: `${r.value}-Major`, label: r.abbr },
  { value: `${r.value}-Minor`, label: r.abbr.split("/").map((s) => `${s}m`).join("/") },
]);
const CAMELOT_OPTIONS: Opt[] = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => [
  { value: `${n}A`, label: `${n}A` },
  { value: `${n}B`, label: `${n}B` },
]);

type Control = "text" | "number" | "select" | "combo";
type FieldDef = {
  col: string;
  label: string;
  control: Control;
  options?: Opt[]; // for "select"
  comboKey?: "genre" | "mood"; // for "combo" (suggestions from the DB)
};
const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Identity",
    fields: [
      { col: "title", label: "Title", control: "text" },
      { col: "artists_text", label: "Artists", control: "text" },
      { col: "album", label: "Album", control: "text" },
      { col: "release_date", label: "Release date", control: "text" },
      { col: "isrc", label: "ISRC", control: "text" },
      { col: "duration_ms", label: "Duration (ms)", control: "number" },
    ],
  },
  {
    title: "Key & tempo",
    fields: [
      { col: "bpm", label: "BPM", control: "number" },
      { col: "key", label: "Key", control: "select", options: KEY_OPTIONS },
      { col: "camelot", label: "Camelot", control: "select", options: CAMELOT_OPTIONS },
      { col: "open_key", label: "Open key", control: "text" },
      { col: "mode", label: "Mode (0 minor / 1 major)", control: "number" },
      { col: "time_signature", label: "Time signature", control: "number" },
      { col: "bpm_confidence", label: "BPM confidence", control: "number" },
      { col: "key_confidence", label: "Key confidence", control: "number" },
    ],
  },
  {
    title: "Audio features",
    fields: [
      { col: "energy", label: "Energy", control: "number" },
      { col: "danceability", label: "Danceability", control: "number" },
      { col: "valence", label: "Valence", control: "number" },
      { col: "acousticness", label: "Acousticness", control: "number" },
      { col: "loudness_db", label: "Loudness (dB)", control: "number" },
      { col: "speechiness", label: "Speechiness", control: "number" },
      { col: "instrumentalness", label: "Instrumentalness", control: "number" },
      { col: "liveness", label: "Liveness", control: "number" },
    ],
  },
  {
    title: "Tags",
    fields: [
      { col: "genre", label: "Genre", control: "combo", comboKey: "genre" },
      { col: "mood", label: "Mood", control: "combo", comboKey: "mood" },
    ],
  },
];

type FieldOptions = { genre: string[]; mood: string[] };

// Flat lookup from column name to its definition (label + control type).
const FIELD_BY_COL: Record<string, FieldDef> = Object.fromEntries(
  FIELD_GROUPS.flatMap((g) => g.fields).map((f) => [f.col, f]),
);

// Expected data type and scale for each numeric field, shown as an input
// placeholder and in the "copy missing values" text.
const NUMERIC_SPEC: Record<string, { type: "float" | "integer"; range: string }> = {
  bpm: { type: "float", range: "~40–250" },
  bpm_confidence: { type: "float", range: "0–1" },
  key_confidence: { type: "float", range: "0–1" },
  energy: { type: "float", range: "0–1" },
  loudness_db: { type: "float", range: "~ -60–0 dB" },
  danceability: { type: "float", range: "0–1" },
  valence: { type: "float", range: "0–1" },
  speechiness: { type: "float", range: "0–1" },
  instrumentalness: { type: "float", range: "0–1" },
  liveness: { type: "float", range: "0–1" },
  acousticness: { type: "float", range: "0–1" },
  duration_ms: { type: "integer", range: "milliseconds" },
  mode: { type: "integer", range: "0 or 1" },
  time_signature: { type: "integer", range: "3–7" },
};

// A column's human-facing type + scale, for the "copy missing values" text.
function fieldTypeLabel(col: string): string {
  const spec = NUMERIC_SPEC[col];
  return spec ? `${spec.type}, ${spec.range}` : "text";
}

// open.spotify.com link for a track URI, or "" if it isn't a track URI.
function spotifyTrackUrl(uri: string | null): string {
  const prefix = "spotify:track:";
  return uri?.startsWith(prefix) ? `https://open.spotify.com/track/${uri.slice(prefix.length)}` : "";
}

// Plain-text report for one track: name, Spotify link, and its missing fields
// (each with the expected data type + scale). Shared by the per-track modal
// button and the "copy all visible tracks" button so both read identically.
function trackReport(title: string, artists: string, uri: string | null, missingCols: string[]): string {
  const lines = missingCols.map((c) => `- ${FIELD_BY_COL[c]?.label ?? c} (${fieldTypeLabel(c)})`);
  return (
    `Song: ${title || "Untitled"}${artists ? ` — ${artists}` : ""}\n` +
    `Spotify: ${spotifyTrackUrl(uri) || "n/a"}\n` +
    `Missing values:\n${lines.length ? lines.join("\n") : "- none"}`
  );
}

// Export/import columns. Identity columns identify the track on re-upload
// (matching on `id`, falling back to `uri`); the CORE_FIELDS are the fillable
// ones (blank = missing). title/artists/spotify_url are reference only.
const EXPORT_IDENTITY = ["id", "uri", "spotify_url", "title", "artists"];
const EXPORT_COLUMNS = [...EXPORT_IDENTITY, ...CORE_FIELDS];

function exportRow(t: TrackDetail): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {
    id: t.id,
    uri: t.uri,
    spotify_url: spotifyTrackUrl(t.uri),
    title: t.title,
    artists: t.artists,
  };
  for (const c of CORE_FIELDS) row[c] = t.fields[c] ?? null;
  return row;
}

// Minimal RFC-4180 CSV: quote any field with a comma, quote or newline.
function toCsv(rows: Record<string, string | number | null>[], columns: string[]): string {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

function downloadFile(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function Metadata() {
  const qc = useQueryClient();
  const toast = useToast();

  const [playlistSel, setPlaylistSel] = useState("all");
  const [missingOnly, setMissingOnly] = useState(false);
  const [orphanOnly, setOrphanOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<TrackDetail | null>(null);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any filter change resets to the first page.
  useEffect(() => setOffset(0), [playlistSel, missingOnly, orphanOnly, search]);

  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const fieldOptions = useQuery({ queryKey: ["trackFieldOptions"], queryFn: api.trackFieldOptions });
  const options: FieldOptions = fieldOptions.data ?? { genre: [], mood: [] };
  const playlistId = playlistSel === "all" ? null : Number(playlistSel);
  // "Not in any playlist" only makes sense across the whole library.
  const orphan = orphanOnly && playlistId === null;

  const tracks = useQuery({
    queryKey: ["tracksDetail", playlistId, missingOnly, orphan, search, offset],
    queryFn: () => api.tracksDetail(playlistId, missingOnly, orphan, search, offset, LIMIT),
    placeholderData: keepPreviousData,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, fields }: { id: number; fields: Record<string, string | number | null> }) =>
      api.updateTrack(id, fields),
    onSuccess: () => {
      toast.notify("Track metadata saved.");
      qc.invalidateQueries({ queryKey: ["tracksDetail"] });
      qc.invalidateQueries({ queryKey: ["libraryHealth"] });
      qc.invalidateQueries({ queryKey: ["trackFieldOptions"] }); // a new genre/mood may have been added
      setSelected(null);
    },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteTrack(id),
    onSuccess: (res) => {
      toast.notify(`Deleted "${res.title}" from the library.`);
      if (selected?.id === res.trackId) setSelected(null);
      qc.invalidateQueries({ queryKey: ["tracksDetail"] });
      qc.invalidateQueries({ queryKey: ["libraryHealth"] });
      qc.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const confirmDelete = (t: TrackDetail) => {
    if (window.confirm(`Delete "${t.title}" from the library? This cannot be undone and does not touch Spotify.`)) {
      deleteMut.mutate(t.id);
    }
  };

  const playlistOptions = useMemo(
    () => [
      { value: "all", label: "All tracks" },
      ...(playlists.data ?? []).map((p) => ({
        value: String(p.id),
        label: `${p.name}${p.curated ? " · curated" : ""} (${p.trackCount})`,
      })),
    ],
    [playlists.data],
  );

  const page = tracks.data;
  const rows = page?.tracks ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + LIMIT, total);

  // Fetch every track matching the current filters (across all pages), so a
  // download covers the whole filtered set, not just the visible page.
  const fetchAllMatching = async (): Promise<TrackDetail[]> => {
    const PAGE = 200;
    const first = await api.tracksDetail(playlistId, missingOnly, orphan, search, 0, PAGE);
    const all = [...first.tracks];
    for (let off = PAGE; off < first.total; off += PAGE) {
      const next = await api.tracksDetail(playlistId, missingOnly, orphan, search, off, PAGE);
      all.push(...next.tracks);
    }
    return all;
  };

  const [exporting, setExporting] = useState(false);
  const download = async (format: "json" | "csv") => {
    setExporting(true);
    try {
      const data = (await fetchAllMatching()).map(exportRow);
      const text = format === "json" ? JSON.stringify(data, null, 2) : toCsv(data, EXPORT_COLUMNS);
      downloadFile(`mixloom-tracks.${format}`, text, format === "json" ? "application/json" : "text/csv");
      toast.notify(`Downloaded ${data.length} track${data.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
    } catch (e) {
      toast.notify((e as Error).message || "Download failed.", "danger");
    } finally {
      setExporting(false);
    }
  };

  const importMut = useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      api.importTracks(filename, content),
    onSuccess: (res) => {
      toast.notify(`Imported: ${res.updated} updated, ${res.skipped} unchanged, ${res.notFound} not matched.`);
      qc.invalidateQueries({ queryKey: ["tracksDetail"] });
      qc.invalidateQueries({ queryKey: ["libraryHealth"] });
      qc.invalidateQueries({ queryKey: ["trackFieldOptions"] });
    },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const onImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be chosen again later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importMut.mutate({ filename: file.name, content: String(reader.result ?? "") });
    reader.onerror = () => toast.notify("Could not read the file.", "danger");
    reader.readAsText(file);
  };

  return (
    <div className="stack">
      <Card>
        <CardHeader
          title="Tracks"
          subtitle="Browse the library (or one playlist), find tracks with missing metadata, and fill in values by hand."
        />
        <CardBody>
          <div className="row" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" }}>
            <div style={{ minWidth: 220 }}>
              <Select label="Scope" value={playlistSel} options={playlistOptions} onChange={setPlaylistSel} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label className="label" htmlFor="meta-search">Search</label>
              <input
                id="meta-search"
                className="input"
                placeholder="Title or artist…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <Button
              variant={missingOnly ? "primary" : "secondary"}
              size="sm"
              aria-pressed={missingOnly}
              onClick={() => setMissingOnly((v) => !v)}
            >
              {missingOnly ? "✓ " : ""}Only missing metadata
            </Button>
            <Button
              variant={orphan ? "primary" : "secondary"}
              size="sm"
              aria-pressed={orphan}
              disabled={playlistId !== null}
              title={playlistId !== null ? "Switch Scope to “All tracks” to use this filter" : undefined}
              onClick={() => setOrphanOnly((v) => !v)}
            >
              {orphan ? "✓ " : ""}Not in any playlist
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          {tracks.isError ? (
            <p className="muted small">Could not load tracks: {(tracks.error as Error).message}</p>
          ) : (
            <div className="stack" style={{ gap: "var(--space-3)" }}>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", flexWrap: "wrap" }}>
                <Button variant="secondary" size="sm" disabled={total === 0 || exporting} loading={exporting} onClick={() => download("json")}>
                  ↓ Download JSON
                </Button>
                <Button variant="secondary" size="sm" disabled={total === 0 || exporting} loading={exporting} onClick={() => download("csv")}>
                  ↓ Download CSV
                </Button>
                <Button variant="secondary" size="sm" loading={importMut.isPending} onClick={() => fileInputRef.current?.click()}>
                  ↑ Import filled file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  style={{ display: "none" }}
                  onChange={onImportFile}
                />
              </div>
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }} aria-label="Art" />
                      <th>Title</th>
                      <th>Artists</th>
                      <th>Album</th>
                      <th>Source</th>
                      <th>Metadata</th>
                      <th style={{ width: 44 }} aria-label="Delete" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr
                        key={t.id}
                        className="clickable"
                        onClick={() => setSelected(t)}
                        title="Edit metadata"
                      >
                        <td><TrackArt url={t.albumArt} size={32} /></td>
                        <td title={t.title}>{t.title}</td>
                        <td title={t.artists}>{t.artists}</td>
                        <td title={t.album}>{t.album}</td>
                        <td className="muted small">{t.featureSource ?? "—"}</td>
                        <td>
                          {t.missing.length === 0 ? (
                            <Badge tone="ok">Complete</Badge>
                          ) : (
                            <span title={`Missing: ${t.missing.join(", ")}`}>
                              <Badge tone="warn">{t.missing.length} missing</Badge>
                            </span>
                          )}
                        </td>
                        <td>
                          <button
                            className="iconbtn iconbtn--danger"
                            title="Delete track from the library"
                            aria-label={`Delete ${t.title}`}
                            disabled={deleteMut.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmDelete(t);
                            }}
                          >
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && !tracks.isLoading && (
                      <tr>
                        <td colSpan={7} className="muted" style={{ textAlign: "center", padding: "var(--space-5)" }}>
                          {orphan
                            ? "No orphan tracks — every track belongs to a playlist."
                            : missingOnly
                              ? "No tracks with missing metadata in this scope."
                              : "No tracks found."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <span className="small faint">
                  {tracks.isLoading ? "Loading…" : `${from}–${to} of ${total.toLocaleString()}`}
                </span>
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                  Prev
                </Button>
                <Button variant="secondary" size="sm" disabled={to >= total} onClick={() => setOffset(offset + LIMIT)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {selected && (
        <TrackEditor
          track={selected}
          options={options}
          saving={updateMut.isPending}
          onCancel={() => setSelected(null)}
          onSave={(fields) => updateMut.mutate({ id: selected.id, fields })}
        />
      )}
    </div>
  );
}

function asInput(value: string | number | null): string {
  return value === null || value === undefined ? "" : String(value);
}

function TrackEditor({
  track,
  options,
  saving,
  onCancel,
  onSave,
}: {
  track: TrackDetail;
  options: FieldOptions;
  saving: boolean;
  onCancel: () => void;
  onSave: (fields: Record<string, string | number | null>) => void;
}) {
  // Initial display strings for every editable field; edits diff against these.
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of FIELD_GROUPS) for (const f of g.fields) m[f.col] = asInput(track.fields[f.col]);
    return m;
  }, [track]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const toast = useToast();

  const set = (col: string, v: string) => setValues((prev) => ({ ...prev, [col]: v }));

  // Copy a plain-text summary of what's still missing (with each field's data
  // type) plus the song name and Spotify link, e.g. to look the values up.
  const copyMissing = async () => {
    const missing = CORE_FIELDS.filter((c) => (values[c] ?? "").trim() === "");
    try {
      await navigator.clipboard.writeText(trackReport(track.title, track.artists, track.uri, missing));
      toast.notify(missing.length ? `Copied ${missing.length} missing field(s).` : "Copied (nothing missing).");
    } catch {
      toast.notify("Could not copy to the clipboard.", "danger");
    }
  };

  const save = () => {
    const patch: Record<string, string | null> = {};
    for (const col of Object.keys(initial)) {
      const current = values[col].trim();
      if (current !== initial[col]) patch[col] = current === "" ? null : current;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    onSave(patch);
  };

  return (
    <Modal
      open
      title={
        <span>
          {track.title || "Untitled"} <span className="muted small">· {track.artists || "unknown artist"}</span>
        </span>
      }
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" style={{ marginRight: "auto" }} onClick={copyMissing}>
            ⧉ Copy missing values
          </Button>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} loading={saving}>Save</Button>
        </>
      }
    >
      {FIELD_GROUPS.map((group) => (
        <fieldset key={group.title} className="fieldgroup">
          <legend>{group.title}</legend>
          <div className="fieldgrid">
            {group.fields.map((f) => {
              const cur = values[f.col];
              const missing = CORE_FIELDS.includes(f.col) && cur.trim() === "";
              return (
                <div key={f.col} className={`field${missing ? " is-missing" : ""}`}>
                  <label className="label" htmlFor={`f-${f.col}`}>
                    {f.label}
                    {missing && <span className="muted small"> · missing</span>}
                  </label>
                  {f.control === "select" ? (
                    <select
                      id={`f-${f.col}`}
                      className="select"
                      value={cur}
                      onChange={(e) => set(f.col, e.target.value)}
                    >
                      <option value="">— none —</option>
                      {/* keep an unexpected existing value selectable */}
                      {cur !== "" && !(f.options ?? []).some((o) => o.value === cur) && (
                        <option value={cur}>{cur}</option>
                      )}
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.control === "combo" ? (
                    <>
                      <input
                        id={`f-${f.col}`}
                        className="input"
                        list={`dl-${f.col}`}
                        value={cur}
                        placeholder="Select or type a new value…"
                        onChange={(e) => set(f.col, e.target.value)}
                      />
                      <datalist id={`dl-${f.col}`}>
                        {(f.comboKey ? options[f.comboKey] : []).map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <input
                      id={`f-${f.col}`}
                      className="input"
                      type={f.control === "number" ? "number" : "text"}
                      step={f.control === "number" ? "any" : undefined}
                      placeholder={NUMERIC_SPEC[f.col]?.range}
                      value={cur}
                      onChange={(e) => set(f.col, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </Modal>
  );
}
