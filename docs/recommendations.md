# Future Features — Recommendations

Opinionated ideas for where this app could go next, grounded in how it is built
today (Postgres + FastAPI + React, enrichment pipeline, curation, Web Playback
SDK). Everything here is a **recommendation**, not a committed plan; effort tags
(**S/M/L**) are rough relative estimates, and each item notes where it would plug
into the existing code.

## Guiding principles

- **Stay single-owner and local-first.** The app's value is giving one person more
  metadata and control than the Spotify client. Keep that focus; resist
  multi-tenant/account complexity unless there's a real need.
- **Lean on metadata you own.** The audio-feature and country data already in
  Postgres is the moat. Prefer features that exploit it locally over ones that
  depend on external APIs.
- **Mind the Spotify API constraints.** Spotify restricted several Web API
  endpoints for new third-party apps in late 2024 (audio features, recommendations,
  related artists, 30-second preview URLs). This is *why* the pipeline uses FreqBlog
  and local analysis. **Verify current access before building on any of them** —
  assume they're unavailable and design around local data.

## Tier 1 — Quick wins (high value, low effort)

| Feature | Why | Where it fits | Effort |
|---|---|---|---|
| **Album art everywhere** | Biggest visual gap vs. real Spotify; the now-playing panel and track rows feel bare without it. | The SDK's `current_track.album.images` is already available for the now-playing panel — zero backend work. For track lists, capture `track.album.images[].url` during **Export** into a new `tracks.album_art_url` column (`schema.sql`, `spotify_playlist_export.py`, `dbutil.upsert_track`). | S |
| **Volume + mute in the panel** | Core transport control that's currently missing. | `controller.player.setVolume()` / `getVolume()` in `lib/playback.ts`; add a slider to `NowPlayingBar.tsx`. | S |
| **Shuffle & repeat toggles** | Expected playback controls. | SDK state exposes `shuffle`/`repeat_mode`; set via the Web API `PUT /me/player/shuffle` and `/repeat`. Add to `usePlayback` + `NowPlayingBar`. | S |
| **Keyboard shortcuts** | Space = play/pause, ←/→ = seek (already on the bar), ↑/↓ = volume. | A global key handler in `App.tsx` calling the `usePlayback` controls. | S |
| **Undo a track removal** | Editing curated playlists (Player) and removing from the Curate pool are destructive with no safety net. | Keep a short in-memory history of the working list; add an "Undo" affordance next to "Save changes". | S |
| **Drag-to-reorder in the Player editor** | Curate already has drag reorder (`PlaylistCard`); the Player's in-place editor only supports removal. | Reuse the drag logic from `Curate.tsx` in the Player `TrackList`. | S |

## Tier 2 — Meaningful additions (medium effort)

### Playback & queue
- **Full queue, not a 100-track window** (**M**). Today `playUris` queues a window
  of `QUEUE_LIMIT = 100` (`lib/playback.ts`). Append the next window automatically
  as playback nears the end of the current one, so long playlists play through.
- **Device picker** (**M**). List the account's Spotify Connect devices
  (`GET /me/player/devices`) and transfer playback, so the app can control playback
  on a phone or speaker instead of only the browser SDK device.
- **A visible "Up next" queue** (**M**). Surface the queued tracks and allow
  "play next" / reorder. Pairs naturally with the full-queue change.

### Curation
- **Edit an existing curated playlist from the Curate tab** (**M**). The Player can
  already edit in place via `PUT /api/playlists/{id}/tracks`; Curate still only
  *creates* new playlists (`db.save_curated`). Add an "open existing curated
  playlist into the builder → save back" flow so the two tabs are symmetric.
- **Update a Spotify playlist in place instead of always creating a new one**
  (**M**). Each push currently runs `create_spotify_playlist.py` and makes a *new*
  private playlist. Store the created Spotify id on the `playlists` row and offer
  "update the existing Spotify playlist" (`PUT /playlists/{id}/tracks` on Spotify)
  to avoid duplicate playlists piling up.
- **Energy-curve / peak-time targeting** (**L-ish M**). Extend the ordering in
  `lib/curate.ts` beyond "smooth / BPM ramp / energy ramp" to fit a chosen *shape*
  (warm-up → peak → cool-down), optimizing the sequence toward a target energy
  curve. Builds directly on the existing transition-cost model.
- **Saved filters / smart playlists** (**M**). Persist a set of Curate filter rules
  (e.g. "Greek, 124–129 BPM, danceable") and re-materialize the matching tracks on
  demand. New `saved_filters` table + a small apply endpoint.

### Library intelligence (uses data you already have)
- **"Find similar tracks" via the audio-feature vector** (**M**). Nearest-neighbour
  over the normalized feature columns (`bpm`, `energy`, `valence`,
  `danceability`, …) in Postgres — no external API. Powers "more like this" and
  "auto-extend this playlist". A pragmatic, local substitute for Spotify's
  (restricted) recommendations endpoint.
- **Cross-library duplicate detection** (**M**). Group tracks by `isrc` (indexed
  already) to flag the same recording appearing under different URIs across
  playlists, and offer a merge/clean view.
- **Re-sync exported playlists** (**M**). Detect when a Spotify playlist has changed
  since export (added/removed tracks) and reconcile, so the DB mirror doesn't drift.

### Dashboard
- **Camelot wheel / harmonic compatibility view** (**M**). Visualize key
  distribution and compatible-key clusters — a natural fit for the DJ-oriented
  audience and the data in `tracks.camelot`.
- **Library-health panel** (**S–M**). Coverage meters: % of tracks with features, %
  of artists with a resolved country, feature-source breakdown — turning the
  pipeline's "missing / total" counts into a single at-a-glance view.

## Tier 3 — Larger bets / foundations

- **Automated tests** (**M, high value**). There's no visible test suite. Start with
  unit tests for the pure logic in `lib/curate.ts` (Camelot parsing, transition
  cost, vibe grouping, sort strategies) and for the backend `db.py` query helpers
  against a throwaway Postgres; add a couple of API smoke tests. This is the single
  best investment for changing the app with confidence.
- **CI pipeline** (**S–M**). Run `tsc --noEmit`, `vite build`, `ruff`/`black`, and
  the tests above on push. Cheap insurance given how much logic lives in the
  frontend.
- **One-command Docker for the whole app** (**M**). Today only Postgres is
  containerized (`db/docker-compose.yml`); the backend and frontend run from a venv
  and npm. A compose profile (or Dockerfiles) that brings up all three would make
  setup and redeploys trivial.
- **Schema migrations** (**S–M**). `schema.sql` is idempotent but there's no
  migration tool. Several features above add columns (`album_art_url`, Spotify
  playlist id, `saved_filters`); adopting a lightweight migration approach now
  avoids ad-hoc `ALTER`s later.
- **Pluggable enrichment providers** (**M**). The feature source is effectively
  FreqBlog-or-local today. A small provider interface (e.g. add Last.fm/Discogs for
  genres/tags, AcousticBrainz-style sources) would make the pipeline resilient to
  any one source changing or disappearing — the same risk that already shaped the
  current design.

## Where to go next

- [overview.md](overview.md) — what the app does today.
- [architecture.md](architecture.md) — components, data flow, and data model these
  features would extend.
- [CLAUDE_Guidelines.md](../CLAUDE_Guidelines.md) — general guidelines for agent (CLAUDE.md).
