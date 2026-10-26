// Spotify Web Playback SDK controller — a module-level singleton so playback
// survives tab switches and is shared across pages (Player, Curate). Components
// subscribe via the `usePlayback` hook.

import { api } from "../api/client";

// Spotify's /play endpoint accepts only a bounded list of URIs, so we start a
// window and then append later windows to the playback queue as the current one
// nears its end (see maybeExtendQueue), letting long playlists play through.
export const QUEUE_LIMIT = 100;
const EXTEND_BATCH = 20; // how many more URIs to append each time
const EXTEND_WHEN_REMAINING = 12; // append when this few upcoming tracks remain
const EXTEND_SPACING_MS = 350; // gap between queue appends, to stay under Spotify's rate limit
const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SdkState = any; // Spotify.PlaybackState (SDK is untyped)

export type Device = { id: string; name: string; type: string; is_active: boolean };

// The full ordered list the user asked to play, plus how far into it we have
// already dispatched to Spotify (window + any appended batches).
type Queue = { uris: string[]; dispatched: number };

export const controller = {
  player: null as any,
  deviceId: null as string | null,
  state: null as SdkState,
  error: null as string | null,
  starting: false, // creating/connecting in progress
  volume: 0.7,
  muted: false,
  preMuteVolume: 0.7,
  queue: null as Queue | null,
  extending: false,
  extendCooldownUntil: 0, // epoch ms; set from a 429 Retry-After to pause appends
  subscribers: new Set<() => void>(),
  notify() {
    this.subscribers.forEach((fn) => fn());
  },
};

// Cache the player access token instead of asking the backend on every request;
// the backend-issued token is valid for ~1 hour and auto-refreshes there, so a
// short client-side cache cuts the request volume that was contributing to 429s.
let cachedToken: { token: string; at: number } | null = null;
const TOKEN_TTL_MS = 30 * 60 * 1000;

async function getToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) {
    return cachedToken.token;
  }
  const { accessToken } = await api.playerToken();
  cachedToken = { token: accessToken, at: Date.now() };
  return accessToken;
}

async function spotifyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const call = (token: string) =>
    fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  let res = await call(await getToken());
  // A cached token may have gone stale; refresh once on 401 and retry.
  if (res.status === 401) {
    res = await call(await getToken(true));
  }
  return res;
}

export function ensurePlayer() {
  if (controller.player || controller.starting) return;
  controller.starting = true;

  const create = () => {
    const Spotify = (window as any).Spotify;
    if (!Spotify) return;
    const player = new Spotify.Player({
      name: "Mixloom",
      volume: controller.volume,
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
      maybeExtendQueue(state);
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

// Queue a window of track URIs starting at `index`, remembering the full list so
// later tracks can be appended automatically. Throws with a readable message
// when the device isn't ready yet or Spotify rejects playback.
export async function playUris(uris: string[], index = 0) {
  if (!controller.deviceId) {
    throw new Error("Player is still connecting — try again in a moment.");
  }
  const window = uris.slice(index, index + QUEUE_LIMIT);
  if (!window.length) return;
  const res = await spotifyFetch(`/me/player/play?device_id=${controller.deviceId}`, {
    method: "PUT",
    body: JSON.stringify({ uris: window }),
  });
  if (res.status === 429) {
    throw new Error("Spotify is rate-limiting playback — wait a few seconds and try again.");
  }
  if (!res.ok && res.status !== 202 && res.status !== 204) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Spotify playback error ${res.status}`);
  }
  controller.queue = { uris, dispatched: index + window.length };
}

// Seconds to back off after a 429, honoring Retry-After when present.
function retryAfterMs(res: Response): number {
  const header = Number(res.headers.get("Retry-After"));
  return (Number.isFinite(header) && header > 0 ? header + 1 : 5) * 1000;
}

// When the current window is nearly exhausted, append the next batch of URIs to
// Spotify's playback queue so a long playlist keeps going past the first 100.
// Requests are spaced out and back off on 429 so we don't trip the rate limiter.
async function maybeExtendQueue(state: SdkState) {
  const q = controller.queue;
  if (!q || controller.extending) return;
  if (q.dispatched >= q.uris.length) return;
  if (Date.now() < controller.extendCooldownUntil) return;
  const remaining = state?.track_window?.next_tracks?.length ?? 0;
  if (remaining > EXTEND_WHEN_REMAINING) return;

  controller.extending = true;
  try {
    const batch = q.uris.slice(q.dispatched, q.dispatched + EXTEND_BATCH);
    for (const uri of batch) {
      const res = await spotifyFetch(
        `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${controller.deviceId}`,
        { method: "POST" },
      );
      if (res.status === 429) {
        // Rate limited: pause further appends and retry after the cooldown.
        controller.extendCooldownUntil = Date.now() + retryAfterMs(res);
        break;
      }
      if (!res.ok && res.status !== 204) break;
      q.dispatched += 1;
      await sleep(EXTEND_SPACING_MS);
    }
  } catch {
    // Leave dispatched where it got to; we'll retry on a later state change.
  } finally {
    controller.extending = false;
  }
}

export async function setVolume(v: number) {
  const vol = Math.max(0, Math.min(1, v));
  controller.volume = vol;
  controller.muted = vol === 0;
  await controller.player?.setVolume(vol);
  controller.notify();
}

export async function toggleMute() {
  if (controller.muted || controller.volume === 0) {
    const restore = controller.preMuteVolume > 0 ? controller.preMuteVolume : 0.5;
    await setVolume(restore);
  } else {
    controller.preMuteVolume = controller.volume;
    await setVolume(0);
  }
}

export async function setShuffle(on: boolean) {
  if (!controller.deviceId) return;
  await spotifyFetch(`/me/player/shuffle?state=${on}&device_id=${controller.deviceId}`, { method: "PUT" });
}

// Cycle off -> context -> track -> off, mirroring the Spotify client.
export async function cycleRepeat(current: number) {
  if (!controller.deviceId) return;
  const nextMode = current === 0 ? "context" : current === 1 ? "track" : "off";
  await spotifyFetch(`/me/player/repeat?state=${nextMode}&device_id=${controller.deviceId}`, { method: "PUT" });
}

export async function listDevices(): Promise<Device[]> {
  const res = await spotifyFetch("/me/player/devices");
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({ devices: [] }));
  return data.devices ?? [];
}

export async function transferPlayback(deviceId: string, play = true) {
  await spotifyFetch("/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}
