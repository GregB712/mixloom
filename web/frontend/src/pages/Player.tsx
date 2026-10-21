import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AuthStatus, type EnvFlags, type PlayerTrack, type PlaylistInfo } from "../api/client";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/ui/Toast";
import { formatDuration } from "../lib/format";

// Spotify's /play endpoint accepts only a bounded list of URIs, so we queue a
// window starting at the clicked track rather than the whole (possibly huge)
// playlist.
const QUEUE_LIMIT = 100;
const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

// --------------------------------------------------------------------------- #
// Playback controller — a module-level singleton so playback survives tab
// switches (the tab unmounts, but the player and its listeners do not).
// --------------------------------------------------------------------------- #
type SdkState = any; // Spotify.PlaybackState (SDK is untyped)

const controller = {
  player: null as any,
  deviceId: null as string | null,
  state: null as SdkState,
  error: null as string | null,
  starting: false, // creating/connecting in progress
  subscribers: new Set<() => void>(),
  notify() {
    this.subscribers.forEach((fn) => fn());
  },
};

function ensurePlayer() {
  if (controller.player || controller.starting) return;
  controller.starting = true;

  const create = () => {
    const Spotify = (window as any).Spotify;
    if (!Spotify) return;
    const player = new Spotify.Player({
      name: "Spotify Playlist Tools",
      volume: 0.7,
      getOAuthToken: (cb: (t: string) => void) => {
        api
          .playerToken()
          .then((r) => cb(r.accessToken))
          .catch(() => {
            controller.error = "Could not get a Spotify access token.";
            controller.notify();
          });
      },
    });

    player.addListener("ready", ({ device_id }: { device_id: string }) => {
      controller.deviceId = device_id;
      controller.error = null;
      controller.notify();
    });
    player.addListener("not_ready", () => {
      controller.deviceId = null;
      controller.notify();
    });
    player.addListener("player_state_changed", (state: SdkState) => {
      controller.state = state;
      controller.notify();
    });
    for (const kind of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
      player.addListener(kind, ({ message }: { message: string }) => {
        controller.error =
          kind === "account_error"
            ? "Playback needs Spotify Premium on the connected account."
            : message || kind;
        controller.notify();
      });
    }

    controller.player = player;
    controller.starting = false;
    player.connect();
    controller.notify();
  };

  if ((window as any).Spotify) {
    create();
  } else {
    (window as any).onSpotifyWebPlaybackSDKReady = create;
    if (!document.getElementById("spotify-sdk")) {
      const s = document.createElement("script");
      s.id = "spotify-sdk";
      s.src = SDK_SRC;
      s.async = true;
      document.body.appendChild(s);
    }
  }
}

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
  return <PlayerBody />;
}

function PlayerBody() {
  const toast = useToast();
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const [selected, setSelected] = useState<number | null>(null);

  // Subscribe this component to the playback controller.
  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    controller.subscribers.add(rerender);
    ensurePlayer();
    return () => {
      controller.subscribers.delete(rerender);
    };
  }, []);

  const list = playlists.data ?? [];
  const tracks = useQuery({
    queryKey: ["playlistTracks", selected],
    queryFn: () => api.playlistTracks(selected as number),
    enabled: selected != null,
  });

  const state = controller.state;
  const current = state?.track_window?.current_track;
  const playing = state ? !state.paused : false;

  async function playFrom(items: PlayerTrack[], index: number) {
    if (!controller.deviceId) {
      toast.notify("Player is still connecting — try again in a moment.");
      return;
    }
    const uris = items.slice(index, index + QUEUE_LIMIT).map((t) => t.uri);
    if (!uris.length) return;
    try {
      const { accessToken } = await api.playerToken();
      const res = await fetch(
        `https://api.spotify.com/v1/me/player/play?device_id=${controller.deviceId}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris }),
        },
      );
      if (!res.ok && res.status !== 202 && res.status !== 204) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error?.message || `Spotify playback error ${res.status}`);
      }
    } catch (e) {
      toast.notify((e as Error).message, "danger");
    }
  }

  return (
    <div className="stack">
      {controller.error && <Callout tone="danger">{controller.error}</Callout>}
      {!controller.deviceId && !controller.error && (
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
            ) : (tracks.data?.length ?? 0) === 0 ? (
              <p className="muted small">This playlist has no playable tracks.</p>
            ) : (
              <TrackList
                tracks={tracks.data as PlayerTrack[]}
                currentUri={current?.uri ?? null}
                onPlay={(i) => playFrom(tracks.data as PlayerTrack[], i)}
              />
            )}
          </CardBody>
        </Card>
      </div>

      {/* Now-playing bar */}
      <div style={{ position: "sticky", bottom: "var(--space-3)", zIndex: 5 }}>
        <Card>
          <CardBody>
            <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                {current ? (
                  <>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {current.name}
                    </div>
                    <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {current.artists?.map((a: any) => a.name).join(", ")}
                    </div>
                  </>
                ) : (
                  <span className="muted small">Nothing playing yet.</span>
                )}
              </div>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!current}
                  onClick={() => controller.player?.previousTrack()}
                  aria-label="Previous track"
                >
                  ⏮
                </Button>
                <Button
                  size="sm"
                  disabled={!current}
                  onClick={() => controller.player?.togglePlay()}
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? "⏸ Pause" : "▶ Play"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!current}
                  onClick={() => controller.player?.nextTrack()}
                  aria-label="Next track"
                >
                  ⏭
                </Button>
              </div>
            </div>
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
}: {
  tracks: PlayerTrack[];
  currentUri: string | null;
  onPlay: (index: number) => void;
}) {
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
        <span className="small muted">{tracks.length} tracks</span>
        <Button size="sm" onClick={() => onPlay(0)}>▶ Play all</Button>
      </div>
      {tracks.map((t, i) => {
        const isCurrent = t.uri === currentUri;
        return (
          <div
            key={t.uri + i}
            className="row"
            style={{
              gap: "var(--space-3)",
              padding: "var(--space-2) 0",
              borderTop: "1px solid var(--border)",
              background: isCurrent ? "var(--surface-2, transparent)" : undefined,
            }}
          >
            <Button variant="ghost" size="sm" onClick={() => onPlay(i)} aria-label={`Play ${t.title}`}>
              ▶
            </Button>
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
          </div>
        );
      })}
    </div>
  );
}
