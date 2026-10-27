import { useEffect, useMemo, useState } from "react";
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

// Canonical dropdown lists. Key uses the enrichment pipeline's enharmonic
// spelling (sharps for C#/F#, flats for Bb/Eb/Ab); Camelot is the full wheel.
const KEY_ROOTS = ["A", "Bb", "B", "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab"];
const KEY_OPTIONS = KEY_ROOTS.flatMap((r) => [`${r}-Major`, `${r}-Minor`]);
const CAMELOT_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => [`${n}A`, `${n}B`]);

type Control = "text" | "number" | "select" | "combo";
type FieldDef = {
  col: string;
  label: string;
  control: Control;
  options?: string[]; // for "select"
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

export function Metadata() {
  const qc = useQueryClient();
  const toast = useToast();

  const [playlistSel, setPlaylistSel] = useState("all");
  const [missingOnly, setMissingOnly] = useState(false);
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
  useEffect(() => setOffset(0), [playlistSel, missingOnly, search]);

  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const fieldOptions = useQuery({ queryKey: ["trackFieldOptions"], queryFn: api.trackFieldOptions });
  const options: FieldOptions = fieldOptions.data ?? { genre: [], mood: [] };
  const playlistId = playlistSel === "all" ? null : Number(playlistSel);

  const tracks = useQuery({
    queryKey: ["tracksDetail", playlistId, missingOnly, search, offset],
    queryFn: () => api.tracksDetail(playlistId, missingOnly, search, offset, LIMIT),
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
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          {tracks.isError ? (
            <p className="muted small">Could not load tracks: {(tracks.error as Error).message}</p>
          ) : (
            <div className="stack" style={{ gap: "var(--space-3)" }}>
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
                      </tr>
                    ))}
                    {rows.length === 0 && !tracks.isLoading && (
                      <tr>
                        <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "var(--space-5)" }}>
                          {missingOnly ? "No tracks with missing metadata in this scope." : "No tracks found."}
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

  const set = (col: string, v: string) => setValues((prev) => ({ ...prev, [col]: v }));

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
                      {cur !== "" && !(f.options ?? []).includes(cur) && <option value={cur}>{cur}</option>}
                      {(f.options ?? []).map((o) => (
                        <option key={o} value={o}>{o}</option>
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
