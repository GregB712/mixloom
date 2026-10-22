import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthStatus, type EnvFlags, type PlayerTrack, type PlaylistInfo } from "../api/client";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { LogPanel } from "../components/ui/LogPanel";
import { TrackArt } from "../components/ui/TrackArt";
import { useToast } from "../components/ui/Toast";
import { useJobStream } from "../hooks/useJobStream";
import { usePlayback } from "../hooks/usePlayback";
import { formatDuration } from "../lib/format";

// --------------------------------------------------------------------------- #
// Page
// --------------------------------------------------------------------------- #
export function Player({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  if (!env.spotify) {
    return (
      <Card>
        <CardBody>
          <Callout tone="warn">
            Spotify API keys aren't configured in <code>.env</code>, so the player can't connect.
          </Callout>
        </CardBody>
      </Card>
    );
  }
  if (!auth.player) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon="🎧" title="Connect the Spotify player">
            In-browser playback uses Spotify's Web Playback SDK and needs one extra authorization
            (streaming scope). This requires a <strong>Spotify Premium</strong> account.
            <div style={{ marginTop: "var(--space-3)" }}>
              <Button onClick={() => { window.location.href = api.loginUrl("player"); }}>
                Connect Spotify (player)
              </Button>
            </div>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }
  return <PlayerBody env={env} auth={auth} />;
}

function PlayerBody({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  const toast = useToast();
  const qc = useQueryClient();
  const pb = usePlayback();
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const [selected, setSelected] = useState<number | null>(null);

  const list = playlists.data ?? [];
  const selectedPl = useMemo(() => list.find((p) => p.id === selected) ?? null, [list, selected]);
  // Only playlists built here (curated, never exported) can be edited in place.
  const editable = !!selectedPl?.curated;

  const tracks = useQuery({
    queryKey: ["playlistTracks", selected],
    queryFn: () => api.playlistTracks(selected as number),
    enabled: selected != null,
  });

  // Local working copy for edits; null = unchanged from the server.
  const [working, setWorking] = useState<PlayerTrack[] | null>(null);
  // Snapshots for undo (each edit pushes the pre-edit list).
  const [history, setHistory] = useState<PlayerTrack[][]>([]);
  const [pushJobId, setPushJobId] = useState<string | null>(null);
  useEffect(() => { setWorking(null); setHistory([]); setPushJobId(null); }, [selected]);

  const serverTracks = (tracks.data as PlayerTrack[] | undefined) ?? [];
  const displayTracks = working ?? serverTracks;
  const dirty =
    working !== null &&
    (working.length !== serverTracks.length ||
      working.some((t, i) => t.uri !== serverTracks[i]?.uri));

  // Push the current list onto the undo stack before a mutation.
  const snapshot = () => setHistory((h) => [...h, displayTracks]);

  const removeAt = (index: number) => {
    snapshot();
    setWorking((prev) => (prev ?? serverTracks).filter((_, i) => i !== index));
  };
  const moveTrack = (from: number, to: number) => {
    if (from === to) return;
    snapshot();
    setWorking((prev) => {
      const base = prev ?? serverTracks;
      if (from < 0 || to < 0 || from >= base.length || to >= base.length) return base;
      const next = [...base];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const undo = () => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      // Restoring the server order exactly clears the working copy.
      const matchesServer =
        prev.length === serverTracks.length && prev.every((t, i) => t.uri === serverTracks[i]?.uri);
      setWorking(matchesServer ? null : prev);
      return h.slice(0, -1);
    });
  };

  const saveMut = useMutation({
    mutationFn: () => api.updatePlaylistTracks(selected as number, displayTracks.map((t) => t.uri)),
    onSuccess: (res) => {
      setWorking(null);
      setHistory([]);
      qc.invalidateQueries({ queryKey: ["playlistTracks", selected] });
      qc.invalidateQueries({ queryKey: ["playlists"] });
      toast.notify(`Saved — ${res.count} track${res.count === 1 ? "" : "s"}.`, "ok");
    },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const pushStream = useJobStream(pushJobId, (ok) =>
    toast.notify(ok ? "Pushed to Spotify." : "Push to Spotify failed. See the log.", ok ? "ok" : "danger"),
  );

  // `update` true => update the existing Spotify playlist in place.
  const pushMut = useMutation({
    mutationFn: async (update: boolean) => {
      if (dirty) {
        await api.updatePlaylistTracks(selected as number, displayTracks.map((t) => t.uri));
        setWorking(null);
        setHistory([]);
        qc.invalidateQueries({ queryKey: ["playlistTracks", selected] });
        qc.invalidateQueries({ queryKey: ["playlists"] });
      }
      const job = await api.createPlaylist(selected as number, selectedPl?.name ?? "", update);
      return job.jobId;
    },
    onSuccess: (id) => { setPushJobId(id); qc.invalidateQueries({ queryKey: ["playlists"] }); },
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  async function playFrom(items: PlayerTrack[], index: number) {
    try {
      await pb.play(items.map((t) => t.uri), index);
    } catch (e) {
      toast.notify((e as Error).message, "danger");
    }
  }

  return (
    <div className="stack">
      {pb.error && <Callout tone="danger">{pb.error}</Callout>}
      {!pb.deviceId && !pb.error && (
        <p className="muted small">Connecting the player to Spotify…</p>
      )}

      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)",
          alignItems: "start",
        }}
      >
        {/* Playlists */}
        <Card>
          <CardBody>
            <h3 className="section-title" style={{ marginTop: 0 }}>Your playlists</h3>
            {playlists.isLoading && <p className="muted small">Loading…</p>}
            {list.length === 0 && !playlists.isLoading && (
              <p className="muted small">No playlists in the database yet.</p>
            )}
            <div className="stack" style={{ gap: "var(--space-1)" }}>
              {list.map((p) => (
                <PlaylistRow
                  key={p.id}
                  pl={p}
                  active={p.id === selected}
                  onClick={() => setSelected(p.id)}
                />
              ))}
            </div>
          </CardBody>
        </Card>

        {/* Tracks */}
        <Card>
          <CardBody>
            {selected == null ? (
              <EmptyState icon="🎵" title="Pick a playlist">
                Select a playlist on the left to see its tracks and play them here.
              </EmptyState>
            ) : tracks.isLoading ? (
              <p className="muted small">Loading tracks…</p>
            ) : displayTracks.length === 0 ? (
              <p className="muted small">
                {editable && dirty
                  ? "You removed every track. Add some back or pick another playlist."
                  : "This playlist has no playable tracks."}
              </p>
            ) : (
              <TrackList
                tracks={displayTracks}
                currentUri={pb.current?.uri ?? null}
                onPlay={(i) => playFrom(displayTracks, i)}
                onRemove={editable ? removeAt : undefined}
                onMove={editable ? moveTrack : undefined}
                headerRight={
                  editable ? (
                    <EditControls
                      env={env}
                      auth={auth}
                      dirty={dirty}
                      canSave={displayTracks.length > 0}
                      canUndo={history.length > 0}
                      hasSpotify={!!selectedPl?.spotifyPlaylistId}
                      saving={saveMut.isPending}
                      pushing={pushMut.isPending || (pushJobId !== null && !pushStream.done)}
                      onUndo={undo}
                      onSave={() => saveMut.mutate()}
                      onPush={(update) => pushMut.mutate(update)}
                    />
                  ) : undefined
                }
              />
            )}
            {selected != null && selectedPl && !editable && selectedPl.spotifyId && (
              <ResyncPanel playlist={selectedPl} auth={auth} />
            )}
            {pushJobId && <LogPanel lines={pushStream.lines} status={pushStream.status} />}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function PlaylistRow({ pl, active, onClick }: { pl: PlaylistInfo; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={active ? "badge badge--accent" : "badge"}
      style={{
        cursor: "pointer",
        display: "flex",
        justifyContent: "space-between",
        gap: "var(--space-2)",
        width: "100%",
        textAlign: "left",
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {pl.curated ? "★ " : ""}{pl.name}
      </span>
      <span className="faint">{pl.trackCount}</span>
    </button>
  );
}

function TrackList({
  tracks,
  currentUri,
  onPlay,
  onRemove,
  onMove,
  headerRight,
}: {
  tracks: PlayerTrack[];
  currentUri: string | null;
  onPlay: (index: number) => void;
  onRemove?: (index: number) => void;
  onMove?: (from: number, to: number) => void;
  headerRight?: ReactNode;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const draggable = !!onMove;

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
        <span className="small muted">{tracks.length} tracks</span>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <Button size="sm" onClick={() => onPlay(0)}>▶ Play all</Button>
          {headerRight}
        </div>
      </div>
      {tracks.map((t, i) => {
        const isCurrent = t.uri === currentUri;
        return (
          <div
            key={t.uri + i}
            className="row"
            draggable={draggable}
            onDragStart={draggable ? (e) => { setDragIndex(i); e.dataTransfer.effectAllowed = "move"; } : undefined}
            onDragOver={draggable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIndex !== i) setOverIndex(i); } : undefined}
            onDrop={draggable ? (e) => { e.preventDefault(); if (dragIndex !== null) onMove!(dragIndex, i); setDragIndex(null); setOverIndex(null); } : undefined}
            onDragEnd={draggable ? () => { setDragIndex(null); setOverIndex(null); } : undefined}
            style={{
              gap: "var(--space-3)",
              padding: "var(--space-2) 0",
              borderTop: "1px solid var(--border)",
              background: isCurrent ? "var(--surface-2, transparent)" : undefined,
              cursor: draggable ? "grab" : undefined,
              opacity: dragIndex === i ? 0.4 : 1,
              boxShadow:
                overIndex === i && dragIndex !== null && dragIndex !== i
                  ? (i < dragIndex ? "inset 0 2px 0 0 var(--accent)" : "inset 0 -2px 0 0 var(--accent)")
                  : undefined,
            }}
          >
            {draggable && <span className="faint" aria-hidden style={{ userSelect: "none" }} title="Drag to reorder">⠿</span>}
            <Button variant="ghost" size="sm" onClick={() => onPlay(i)} aria-label={`Play ${t.title}`}>
              ▶
            </Button>
            <TrackArt url={t.albumArt} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontWeight: isCurrent ? 600 : 400,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {isCurrent && <span aria-hidden>🔊 </span>}{t.title}
              </div>
              <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.artists}{t.album ? ` · ${t.album}` : ""}
              </div>
            </div>
            {t.durationMs != null && (
              <span className="small faint">{formatDuration(t.durationMs)}</span>
            )}
            {onRemove && (
              <Button variant="ghost" size="sm" onClick={() => onRemove(i)} aria-label={`Remove ${t.title}`}>
                ✕
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Edit/push controls shown only for curated (database-only) playlists.
function EditControls({
  env,
  auth,
  dirty,
  canSave,
  canUndo,
  hasSpotify,
  saving,
  pushing,
  onUndo,
  onSave,
  onPush,
}: {
  env: EnvFlags;
  auth: AuthStatus;
  dirty: boolean;
  canSave: boolean;
  canUndo: boolean;
  hasSpotify: boolean;
  saving: boolean;
  pushing: boolean;
  onUndo: () => void;
  onSave: () => void;
  onPush: (update: boolean) => void;
}) {
  const undoBtn = (
    <Button variant="ghost" size="sm" disabled={!canUndo} onClick={onUndo} aria-label="Undo last change">
      ↶ Undo
    </Button>
  );
  const saveBtn = (
    <Button variant="secondary" size="sm" disabled={!dirty || !canSave} loading={saving} onClick={onSave}>
      {dirty ? "Save changes" : "Saved"}
    </Button>
  );

  if (env.spotify && !auth.write) {
    return (
      <>
        {undoBtn}
        {saveBtn}
        <Button size="sm" onClick={() => { window.location.href = api.loginUrl("write"); }}>
          Connect Spotify (write)
        </Button>
      </>
    );
  }
  return (
    <>
      {undoBtn}
      {saveBtn}
      {hasSpotify && (
        <Button variant="secondary" size="sm" disabled={!env.spotify || !canSave || pushing} loading={pushing} onClick={() => onPush(true)}>
          Update Spotify
        </Button>
      )}
      <Button size="sm" disabled={!env.spotify || !canSave || pushing} loading={pushing} onClick={() => onPush(false)}>
        {hasSpotify ? "Push as new" : "Push to Spotify"}
      </Button>
    </>
  );
}

// Detect and reconcile drift between an exported playlist's DB mirror and its
// live Spotify contents.
function ResyncPanel({ playlist, auth }: { playlist: PlaylistInfo; auth: AuthStatus }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["resync", playlist.id],
    queryFn: () => api.resyncStatus(playlist.id),
    enabled: false, // only on demand
  });

  const stream = useJobStream(jobId, (ok) => {
    toast.notify(ok ? "Re-imported from Spotify." : "Re-import failed. See the log.", ok ? "ok" : "danger");
    if (ok) {
      qc.invalidateQueries({ queryKey: ["playlists"] });
      qc.invalidateQueries({ queryKey: ["playlistTracks", playlist.id] });
      status.refetch();
    }
  });

  const reimport = useMutation({
    mutationFn: async () => {
      const job = await api.export([playlist.spotifyId as string]);
      return job.jobId;
    },
    onSuccess: (id) => setJobId(id),
    onError: (e: Error) => toast.notify(e.message, "danger"),
  });

  const s = status.data;
  return (
    <div className="stack" style={{ gap: "var(--space-2)", borderTop: "1px solid var(--border)", paddingTop: "var(--space-4)", marginTop: "var(--space-3)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">Sync with Spotify</span>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          {!auth.read ? (
            <Button size="sm" onClick={() => { window.location.href = api.loginUrl("read"); }}>Connect Spotify (read)</Button>
          ) : (
            <Button variant="secondary" size="sm" loading={status.isFetching} onClick={() => status.refetch()}>
              Check for changes
            </Button>
          )}
        </div>
      </div>
      {status.isError && <Callout tone="danger">{(status.error as Error).message}</Callout>}
      {s && (
        s.inSync ? (
          <Callout tone="ok">In sync — {s.dbCount} tracks match Spotify.</Callout>
        ) : (
          <Callout tone="warn">
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <div>
                Drift detected: {s.added.length} added and {s.removed.length} removed on Spotify
                since export (DB {s.dbCount} · Spotify {s.liveCount}).
              </div>
              {s.added.length > 0 && (
                <div className="small">Added on Spotify: {s.added.slice(0, 5).map((t) => t.title || t.uri).join(", ")}{s.added.length > 5 ? "…" : ""}</div>
              )}
              {s.removed.length > 0 && (
                <div className="small">Removed on Spotify: {s.removed.slice(0, 5).map((t) => t.title || t.uri).join(", ")}{s.removed.length > 5 ? "…" : ""}</div>
              )}
              <div>
                <Button size="sm" loading={reimport.isPending || (jobId !== null && !stream.done)} onClick={() => reimport.mutate()}>
                  Re-import from Spotify
                </Button>
              </div>
            </div>
          </Callout>
        )
      )}
      {jobId && <LogPanel lines={stream.lines} status={stream.status} />}
    </div>
  );
}
