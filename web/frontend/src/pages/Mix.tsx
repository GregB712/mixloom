import { Fragment, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthStatus, type EnvFlags, type Track } from "../api/client";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { LogPanel } from "../components/ui/LogPanel";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { TrackArt } from "../components/ui/TrackArt";
import { useToast } from "../components/ui/Toast";
import { useDragAutoScroll } from "../hooks/useDragAutoScroll";
import { useJobStream } from "../hooks/useJobStream";
import { formatDuration } from "../lib/format";
import { moveUnlocked, swapCandidates, totalDurationMs, transitionCost, type Unit } from "../lib/curate";
import { MixDot, TrackChips } from "./Curate";

// Repeated clicks on one unit's swap button walk its ranked candidates, always
// computed from the order before the first click.
type Cycle = { index: number; base: Unit[]; candidates: number[]; rank: number };
// A continuous run of selected units, by unit index (inclusive).
type Selection = { from: number; to: number };

export function Mix({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  const toast = useToast();
  const qc = useQueryClient();
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const library = useQuery({ queryKey: ["curate", "all"], queryFn: () => api.curateTracks([]) });

  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [addAt, setAddAt] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const latestLoad = useRef<number | null>(null);
  useDragAutoScroll(listRef, dragIndex !== null);

  const byUri = useMemo(() => new Map((library.data?.tracks ?? []).map((t) => [t.uri, t])), [library.data]);
  const tracks = useMemo(() => units?.flat() ?? [], [units]);
  const unitLocked = (u: Unit) => locked.has(u[0].uri);

  // Loads the saved order of a playlist. A slower answer for a playlist picked
  // earlier is ignored, so the list never shows (and saves) another playlist's tracks.
  const open = async (id: number) => {
    latestLoad.current = id;
    setPlaylistId(id);
    setJobId(null);
    setUnits(null);
    setLocked(new Set());
    setCycle(null);
    setSel(null);
    try {
      const ordered = await api.playlistTracks(id);
      if (latestLoad.current !== id) return;
      const list = ordered.map((p) => byUri.get(p.uri)).filter((t): t is Track => !!t);
      setUnits(list.map((t) => [t]));
      setSaved(list.map((t) => t.uri));
    } catch (e) {
      toast.notify((e as Error).message, "danger");
    }
  };

  // Any edit other than cycling the same unit starts a fresh cycle; indices
  // shift, so the selection is dropped too.
  const edit = (next: Unit[]) => {
    setCycle(null);
    setSel(null);
    setUnits(next);
  };

  const swap = (k: number) => {
    if (!units) return;
    const same = cycle && cycle.index === k;
    const base = same ? cycle.base : units;
    const candidates = same ? cycle.candidates : swapCandidates(units, k, locked);
    if (!candidates.length) return toast.notify("No unlocked tracks to swap with.", "danger");
    const rank = same ? (cycle.rank + 1) % candidates.length : 0;
    const j = candidates[rank];
    const next = [...base];
    [next[k], next[j]] = [next[j], next[k]];
    setSel(null);
    setUnits(next);
    setCycle({ index: k, base, candidates, rank });
  };

  // Locking a block locks every track in it, so a split keeps them locked.
  const toggleLock = (u: Unit) => {
    setSel(null);
    setLocked((s) => {
      const n = new Set(s);
      const on = !s.has(u[0].uri);
      for (const t of u) {
        if (on) n.add(t.uri);
        else n.delete(t.uri);
      }
      return n;
    });
  };

  // Ticking a unit extends the selection to it, so it is always continuous.
  const select = (k: number) => {
    if (!units) return;
    if (sel && k >= sel.from && k <= sel.to) return setSel(null);
    const from = sel ? Math.min(sel.from, k) : k;
    const to = sel ? Math.max(sel.to, k) : k;
    if (units.slice(from, to + 1).some(unitLocked)) return toast.notify("A selection can't include a locked track.", "danger");
    setSel({ from, to });
  };

  const inSel = (k: number) => !!sel && k >= sel.from && k <= sel.to;
  const selUnits = sel && units ? units.slice(sel.from, sel.to + 1) : [];
  const makeBlock = () => sel && units && edit([...units.slice(0, sel.from), selUnits.flat(), ...units.slice(sel.to + 1)]);
  const splitBlocks = () => units && edit(units.flatMap((u, k) => (inSel(k) ? u.map((t) => [t]) : [u])));

  const removeTrack = (t: Track) => {
    if (!units) return;
    edit(units.map((u) => u.filter((x) => x.uri !== t.uri)).filter((u) => u.length));
    setLocked((s) => { const n = new Set(s); n.delete(t.uri); return n; });
  };

  const uris = tracks.map((t) => t.uri);
  const dirty = uris.join() !== saved.join();

  const save = useMutation({
    mutationFn: () => api.updatePlaylistTracks(playlistId as number, uris),
    onSuccess: (r) => {
      setSaved(uris);
      qc.invalidateQueries({ queryKey: ["playlists"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast.notify(`Saved ${r.count} tracks.`, "ok");
    },
    onError: (e) => toast.notify((e as Error).message, "danger"),
  });

  // Update the playlist's existing Spotify counterpart in place (never creates
  // one). Unsaved changes are saved first, since the push reads the database.
  const info = playlists.data?.find((p) => p.id === playlistId);
  const onSpotify = !!(info?.spotifyId || info?.spotifyPlaylistId);
  const [jobId, setJobId] = useState<string | null>(null);
  const stream = useJobStream(jobId, (ok) =>
    toast.notify(ok ? "Updated on Spotify." : "Spotify update failed. See the log.", ok ? "ok" : "danger"),
  );
  const push = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return (await api.updateOnSpotify(playlistId as number)).jobId;
    },
    onSuccess: setJobId,
    onError: (e) => toast.notify((e as Error).message, "danger"),
  });
  const pushBusy = push.isPending || (jobId !== null && !stream.done);

  const options = [
    { value: "", label: "Choose a playlist…" },
    ...(playlists.data ?? []).map((p) => ({ value: String(p.id), label: `${p.name} (${p.trackCount})` })),
  ];

  let trackNo = 0; // running track number while rendering units

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Mix" subtitle="Fine-tune a playlist's transitions in its saved order" />
        <CardBody>
          <div style={{ maxWidth: 420 }}>
            <Select
              label="Playlist"
              value={playlistId === null ? "" : String(playlistId)}
              options={options}
              disabled={!library.data}
              onChange={(v) => {
                if (!v || (dirty && !window.confirm("Discard your unsaved changes to this playlist?"))) return;
                open(Number(v));
              }}
            />
          </div>
          {library.isError && <Callout tone="danger">{(library.error as Error).message}</Callout>}
        </CardBody>
      </Card>

      {playlistId !== null && (
        <Card>
          <CardHeader
            title={playlists.data?.find((p) => p.id === playlistId)?.name ?? "Playlist"}
            subtitle={units ? `${tracks.length} tracks · ${formatDuration(totalDurationMs(tracks))} · ${locked.size} locked` : "Loading…"}
            right={
              units ? (
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => open(playlistId)}>Discard</Button>
                  <Button size="sm" variant={onSpotify && env.spotify && auth.write ? "secondary" : "primary"} disabled={!dirty || !tracks.length} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
                  {onSpotify && env.spotify && auth.write && (
                    <Button size="sm" disabled={!tracks.length || pushBusy} loading={pushBusy} onClick={() => push.mutate()}
                      title={dirty ? "Save, then update this playlist on Spotify" : "Update this playlist on Spotify"}>
                      Update on Spotify
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          />
          <CardBody>
            {units && env.spotify && (!onSpotify ? (
              <span className="small faint">This playlist isn't on Spotify yet. Create it from the Curate tab first; Mix only updates existing ones.</span>
            ) : !auth.write && (
              <div className="row">
                <span className="muted small">Updating on Spotify needs write access.</span>
                <Button size="sm" onClick={() => { window.location.href = api.loginUrl("write"); }}>Connect Spotify (write)</Button>
              </div>
            ))}
            {jobId && <LogPanel lines={stream.lines} status={stream.status} />}
            {units && units.length === 0 && (
              <EmptyState icon="➕" title="Empty playlist">
                <Button size="sm" onClick={() => setAddAt(0)}>+ Add a track</Button>
              </EmptyState>
            )}
            {units && units.length > 0 && (
              <>
                {sel && (
                  <div className="row mixsel" style={{ gap: "var(--space-2)" }}>
                    <span className="small">{selUnits.flat().length} tracks selected</span>
                    <div className="card__spacer" />
                    <Button size="sm" disabled={selUnits.length < 2} onClick={makeBlock}>Make block</Button>
                    {selUnits.some((u) => u.length > 1) && (
                      <Button variant="secondary" size="sm" onClick={splitBlocks}>Split block</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setSel(null)}>Clear</Button>
                  </div>
                )}
                <div ref={listRef} className="multiselect__box" style={{ maxHeight: "none", overflow: "visible" }}>
                  <Gap onAdd={() => setAddAt(0)} />
                  {units.map((u, k) => {
                    const isLocked = unitLocked(u);
                    const block = u.length > 1;
                    const cycling = cycle?.index === k;
                    const first = trackNo;
                    trackNo += u.length;
                    const label = block ? `block ${u[0].title}` : u[0].title;
                    return (
                      <Fragment key={u[0].uri}>
                        <div
                          className={`mixunit${block ? " mixunit--block" : ""}`}
                          draggable={!isLocked}
                          onDragStart={(e) => { setDragIndex(k); e.dataTransfer.effectAllowed = "move"; }}
                          onDragOver={(e) => {
                            if (dragIndex === null || isLocked) return; // locked units are not drop targets
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (overIndex !== k) setOverIndex(k);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIndex !== null) edit(moveUnlocked(units, dragIndex, k, locked));
                            setDragIndex(null);
                            setOverIndex(null);
                          }}
                          onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                          style={{
                            cursor: isLocked ? "default" : "grab",
                            opacity: dragIndex === k ? 0.4 : 1,
                            background: inSel(k)
                              ? "color-mix(in oklab, var(--accent) 14%, transparent)"
                              : isLocked ? "var(--surface)" : undefined,
                            boxShadow:
                              overIndex === k && dragIndex !== null && dragIndex !== k
                                ? (k < dragIndex ? "inset 0 2px 0 0 var(--accent)" : "inset 0 -2px 0 0 var(--accent)")
                                : undefined,
                          }}
                        >
                          {u.map((t, m) => {
                            const i = first + m;
                            const head = m === 0;
                            // Only a unit's first row carries its handle, selection, swap and lock.
                            const unitOnly = head ? undefined : ("hidden" as const);
                            return (
                              <div className="option" key={t.uri} style={{ cursor: "inherit" }}>
                                <span className="faint" aria-hidden style={{ userSelect: "none", visibility: isLocked ? "hidden" : unitOnly }} title="Drag to reorder">⠿</span>
                                <input
                                  type="checkbox"
                                  checked={inSel(k)}
                                  disabled={isLocked}
                                  onChange={() => select(k)}
                                  aria-label={`Select ${label}`}
                                  style={{ visibility: unitOnly }}
                                  tabIndex={head ? undefined : -1}
                                />
                                <MixDot prev={i > 0 ? tracks[i - 1] : null} curr={t} />
                                <span className="faint small" style={{ width: 28, textAlign: "right" }}>{i + 1}</span>
                                <TrackArt url={t.albumArt} size={32} />
                                <span className="option__name">
                                  <strong>{t.title || "(untitled)"}</strong>
                                  <span className="muted"> — {t.artists}</span>
                                </span>
                                <TrackChips track={t} />
                                <button
                                  className="btn btn--ghost btn--sm"
                                  disabled={isLocked || !head}
                                  onClick={() => swap(k)}
                                  aria-label={`Swap ${label} for a smoother match`}
                                  title={cycling ? `Match ${cycle.rank + 1} of ${cycle.candidates.length}, click for the next` : "Swap in the smoothest unlocked match"}
                                  style={{ color: cycling ? "var(--brand)" : undefined, visibility: unitOnly }}
                                  tabIndex={head ? undefined : -1}
                                >⇄{cycling ? ` ${cycle.rank + 1}` : ""}</button>
                                <button
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => toggleLock(u)}
                                  aria-pressed={isLocked}
                                  aria-label={isLocked ? `Unlock ${label}` : `Lock ${label} in place`}
                                  title={isLocked ? "Locked in place" : "Lock in place"}
                                  style={{ visibility: unitOnly }}
                                  tabIndex={head ? undefined : -1}
                                >{isLocked ? "🔒" : "🔓"}</button>
                                <button className="btn btn--ghost btn--sm" onClick={() => removeTrack(t)} aria-label={`Remove ${t.title}`}>✕</button>
                              </div>
                            );
                          })}
                        </div>
                        <Gap onAdd={() => setAddAt(k + 1)} />
                      </Fragment>
                    );
                  })}
                </div>
                <span className="small faint">
                  Drag <span aria-hidden>⠿</span> to reorder by hand (locked tracks stay put). Tick tracks next to each other to make a block that drags, swaps and locks as one;
                  a block swaps by its first track. Hover between tracks to add one there. ⇄ swaps in the smoothest unlocked match; click again for the next.
                  Dots show mix quality from the previous track.
                </span>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {addAt !== null && units && (
        <AddTrackModal
          library={library.data?.tracks ?? []}
          exclude={new Set(uris)}
          prev={addAt > 0 ? units[addAt - 1][units[addAt - 1].length - 1] : null}
          next={addAt < units.length ? units[addAt][0] : null}
          position={units.slice(0, addAt).flat().length + 1}
          onClose={() => setAddAt(null)}
          onAdd={(t) => {
            edit([...units.slice(0, addAt), [t], ...units.slice(addAt)]);
            setAddAt(null);
          }}
        />
      )}
    </div>
  );
}

// Thin hover strip between rows; its + button opens the add dialog for that slot.
function Gap({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mixgap">
      <button className="mixgap__btn" onClick={onAdd} aria-label="Add a track here">+</button>
    </div>
  );
}

function AddTrackModal({
  library,
  exclude,
  prev,
  next,
  position,
  onClose,
  onAdd,
}: {
  library: Track[];
  exclude: Set<string>;
  prev: Track | null;
  next: Track | null;
  position: number;
  onClose: () => void;
  onAdd: (t: Track) => void;
}) {
  const [q, setQ] = useState("");
  // Best fit for this slot first, so a blank search already suggests tracks.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const fit = (t: Track) => (prev ? transitionCost(prev, t) : 0) + (next ? transitionCost(t, next) : 0);
    return library
      .filter((t) => !exclude.has(t.uri) && (!needle || `${t.title} ${t.artists} ${t.album}`.toLowerCase().includes(needle)))
      .map((t) => ({ t, cost: fit(t) }))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, 50)
      .map((r) => r.t);
  }, [library, exclude, prev, next, q]);

  return (
    <Modal open title={`Add a track at #${position}`} onClose={onClose}>
      <div className="stack" style={{ gap: "var(--space-3)" }}>
        <input
          className="input"
          autoFocus
          placeholder="Search title, artist or album"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search tracks"
        />
        <span className="small faint">Sorted by how smoothly each track fits between its neighbours.</span>
        {results.length === 0 ? (
          <span className="small faint">No matching tracks.</span>
        ) : (
          <div className="multiselect__box" style={{ maxHeight: 400 }}>
            {results.map((t) => (
              <div className="option" key={t.uri} onClick={() => onAdd(t)}>
                <MixDot prev={prev} curr={t} />
                <TrackArt url={t.albumArt} size={28} />
                <span className="option__name">
                  <strong>{t.title || "(untitled)"}</strong>
                  <span className="muted"> — {t.artists}</span>
                </span>
                <TrackChips track={t} />
                <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); onAdd(t); }} aria-label={`Add ${t.title}`}>+ Add</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
