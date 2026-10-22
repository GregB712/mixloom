# Overview & Capabilities

## What this app is

**Mixloom** is a personal, self-hosted app for building and
understanding Spotify playlists using **more metadata than the Spotify app
exposes** — artist country, musical key (Camelot), BPM, energy, valence,
danceability, mood, genre, and more.

Spotify's own client lets you make playlists, but gives you almost nothing to
reason about *why* tracks fit together. This app fills that gap:

1. **Collect** your playlists into a local Postgres database.
2. **Enrich** every track and artist with metadata from external sources, or from
   analysing the audio itself when the APIs come up empty.
3. **Curate** new playlists by filtering and grouping on that metadata, and order
   them like a DJ would (compatible keys, smooth tempo and energy flow).
4. **Play** the results in the browser.

It's built for one owner running it locally — your Spotify credentials, your
database, your machine. Secrets stay on the backend and never reach the browser.

## Who it's for

- Anyone who wants to build **harmonically and rhythmically coherent** playlists
  (DJ-style key/tempo matching) instead of eyeballing a track list.
- People who want to **slice a library by metadata** — "danceable Greek tracks
  between 124–129 BPM", "mellow, moody, under 110 BPM" — which Spotify can't do.
- Anyone curious about the **shape of their library**: country mix, tempo
  distribution, energy/valence spread, top artists.

## The pipeline

Each step reads from and writes to the shared Postgres database. Steps are
**incremental** — re-running only processes what's still missing.

| Step | Source | Writes | Notes |
|------|--------|--------|-------|
| **Export** | Spotify API (read) | `tracks`, `artists`, `playlists` | Per-playlist, no merge. Tracks deduplicated by URI across the whole library. |
| **Enrich countries** | MusicBrainz | `artists.country_*` | Cached + rate-limited. Only artists missing a country, unless `--all`. |
| **Enrich features** | Pluggable provider (FreqBlog or Last.fm) | `tracks` audio features / tags | Only feature-less tracks, unless `--all`. `feature_source` names the provider. |
| **Analyse local audio** | Your audio files (librosa) | `tracks` audio features | For tracks the APIs couldn't fill. `feature_source = local-estimate`. |
| **Manual import** | Hand-filled JSON | `artists` / `tracks` | For rows you fill in yourself. `*_status`/`feature_source = manual`. |
| **Create / update playlist** | A DB playlist | Spotify (write) | Creates a new **private** playlist, or updates the one it created before in place (`--update`). |

### A note on honesty of the data

- **Country** comes from MusicBrainz name matching, which can be ambiguous; the
  match quality is recorded in `artists.country_status`. "Greek" throughout the
  app means an artist resolved to `country_code = 'GR'`.
- **Audio features** from FreqBlog are looked up per track. When a track isn't
  found, local analysis can estimate features from the audio — but only some are
  faithfully derivable (BPM, key/mode/Camelot, loudness, an energy proxy). The
  perceptual ones (danceability, valence, speechiness, etc.) are **rough
  heuristic estimates**, flagged by `feature_source = local-estimate`.

## Capabilities by area

### Run pipeline tab
- Connect Spotify read/write/player scopes independently (each a separate button
  and token cache); the header shows which `.env` keys are set.
- Refresh and multi-select which Spotify playlists to export.
- Scope country and feature enrichment to selected playlists or the whole library.
- See a **"missing / total"** coverage count on each enrich card.
- **Download a JSON template** of the artists missing a country, or tracks missing
  features, to fill by hand — then import it back with `import_manual.py`.
- Analyse a local folder of downloaded audio for tracks the APIs couldn't fill.
- Push a DB playlist to Spotify as a new private playlist.
- Every run streams the script's real log output live, with final status.

### Curate tab
- **Multi-select source playlists**; duplicate tracks across them are removed from
  the working pool.
- **Manual pick** with a filter for every metadata field:
  - categories: genre, mood, Camelot key, Greek (yes/no/any), album text search;
  - ranges: BPM, energy, valence, danceability, acousticness, duration.
- **Auto by vibe** — one click groups the pool into cards:
  - *Energy × mood quadrants* (Peak/Sunny/Dark/Mellow),
  - *Tempo bands* (Warm-up / Groove / Peak / High-energy),
  - *Partying* (Greek vs non-Greek),
  - *FreqBlog mood*, or *Genre*.
- **Save a filter set** as a reusable "smart playlist" and re-apply it in one click.
- **DJ-style ordering** of the chosen set:
  - *Smooth* — greedy "best next track" over Camelot-key compatibility, BPM
    proximity, and energy flow;
  - *Energy curve* — a warm-up that rises to a mid-set peak, then cools down;
  - *BPM ramp* or *Energy ramp*;
  - *Manual* — drag and drop to reorder by hand.
- Per-track **album art**, **key / BPM / energy chips**, and a **mix-quality dot**
  (great / ok / jump) between consecutive tracks.
- **Undo** the last edit, and **✨ More like this** to pull in nearest-neighbour
  tracks by audio-feature similarity (local, no external API).
- **Play the built playlist** from the "Your playlist" panel when the player is
  connected.
- **Save** the ordered result as a curated playlist in the DB; with write access,
  create the matching private Spotify playlist in that exact order. You can also
  **open an existing curated playlist** back into the builder and save changes in
  place (updating its Spotify copy when it has one).

### Dashboard tab
- Inspect one playlist or the whole library.
- Metrics: track count, unique artists, unique albums, total duration, % Greek,
  median BPM.
- Charts: top artists, tracks per source playlist, top country codes, Greek
  classification, lookup status, audio-feature histograms, and category charts
  (Camelot / genre / mood).
- A **Camelot wheel** visualising key distribution and harmonic-compatibility
  clusters.
- Whole-library only: a **library-health** panel (feature / album-art / country
  coverage meters and feature-source breakdown) and **cross-library duplicate
  detection** (the same recording under different URIs, grouped by ISRC).
- Searchable, paginated raw-data table.
- Sections appear only for the metadata the current selection actually has.

### Player tab
- In-browser playback via Spotify's **Web Playback SDK** (requires **Spotify
  Premium** and a secure context — open the app over `localhost`).
- Lists your DB playlists — both exported and curated — and plays them by each
  track's Spotify URI, so a curated playlist you never pushed to Spotify plays
  just like an exported one.
- Per-track and "play all" buttons with **album art**, and playback that continues
  while you switch tabs.
- **Edit curated (database-only) playlists in place** — remove tracks, **drag to
  reorder**, and **undo** — then save back to the database.
- **Push a curated playlist to Spotify** (needs write access) either as a new
  private playlist or **updating the existing Spotify playlist in place**.
- For **exported** playlists, **check for drift** against Spotify (tracks
  added/removed since export) and **re-import** to reconcile. Exported playlists
  are otherwise read-only here.

### Now-playing panel (every tab)
- Playback is driven from a single floating now-playing panel that is available on
  **every tab**, not just the Player — a small chip (bottom-left) that **expands on
  hover or focus** into the full controls.
- Shows album art, the current track and artists, **shuffle / previous /
  play-pause / next / repeat**, a **seekable progress bar** with elapsed / total
  time, a **volume slider with mute**, an **"up next"** queue, and a **device
  picker** to transfer playback to a phone or speaker.
- **Keyboard shortcuts** work anywhere outside a text field: Space = play/pause,
  ←/→ = seek, ↑/↓ = volume.
- Long playlists keep playing past the first 100 tracks — the queue extends
  automatically as the current window runs down.
- Appears whenever the player is connected and a track is loaded, and reflects
  whatever is playing regardless of which tab started it.

## Two ways to use it

- **Web app** (`web/`) — the four tabs above, the primary interface.
- **CLI scripts** (`scripts/`) — the same pipeline steps from a terminal, handy
  for scripting or large/slow runs. See the [README](../README.md) section 4.

Both share the same database, `.env`, and Spotify token caches.

## Where to go next

- [README](../README.md) — install, configure, and run.
- [architecture.md](architecture.md) — components, data flow, data model, and the
  technology stack.
- [recommendations.md](recommendations.md) — recommended future features, grounded
  in the current design.
