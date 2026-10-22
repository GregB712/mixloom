# Architecture

This document describes how the app is built, how data flows through it, and the
database schema. For what the app *does*, see [overview.md](overview.md).

## Technology stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 16 (Docker, `db/docker-compose.yml`) |
| DB driver | `psycopg` 3 |
| Backend | FastAPI + Uvicorn (Python 3.10+) |
| Spotify | `spotipy` (OAuth read / write / player scopes) |
| Enrichment | MusicBrainz (HTTP), pluggable feature providers (FreqBlog, Last.fm), `librosa` + `mutagen` (local audio) |
| Frontend | React 18 + TypeScript + Vite, `@tanstack/react-query` |
| In-browser playback | Spotify Web Playback SDK |
| Tests | Vitest (frontend), pytest + FastAPI TestClient (backend) |
| Migrations | `scripts/db_migrate.py` + `db/migrations/*.sql` (tracked in `schema_migrations`) |

Everything runs on one machine against one local Postgres database and one `.env`.

## Components

```
                         ┌──────────────────────────────────────────┐
                         │            Postgres (spotify_meta)         │
                         │  tracks · artists · track_artists ·        │
                         │  playlists · playlist_tracks               │
                         └──────────────────────────────────────────┘
                              ▲            ▲                   ▲
            writes/reads      │            │ reads             │ reads/writes
                              │            │                   │
   ┌──────────────────┐   ┌───┴────────┐   │        ┌──────────┴───────────┐
   │  CLI scripts/    │   │  dbutil.py │   │        │   FastAPI backend     │
   │  (pipeline steps)│──▶│  (shared   │   │        │   web/backend/        │
   │                  │   │   helpers) │   │        │   db.py · main.py ·   │
   └──────────────────┘   └────────────┘   │        │   auth.py · jobs.py   │
            │                               │        └──────────┬───────────┘
            │ subprocess (live logs)        │                   │ /api (JSON + SSE)
            └───────────────────────────────┘                   │
   ┌────────────────────────┐                        ┌──────────┴───────────┐
   │  Spotify / MusicBrainz  │◀───────────────────────│   React frontend      │
   │  / FreqBlog / local     │   Web Playback SDK ────▶│   web/frontend/       │
   │  audio files            │   (browser → Spotify)   │   Run · Curate ·      │
   └────────────────────────┘                         │   Dashboard · Player  │
                                                       └───────────────────────┘
```

### CLI scripts (`scripts/`)
Each pipeline step is a standalone script. They share `dbutil.py` for the DB
connection, coercion helpers, and upsert logic (`upsert_track`,
`get_or_create_artist`, `set_track_artists`, `update_artist_country`,
`update_track_features`, `upsert_playlist`, `link_playlist_track`). Paths
(`.env`, caches, schema) resolve relative to the repo root via `dbutil.ROOT`.

### Backend (`web/backend/`)
- `config.py` — loads `.env`, defines scopes, token-cache paths, `DATABASE_URL`,
  and derives the bind host/port + callback path from `SPOTIPY_REDIRECT_URI`.
- `auth.py` — server-side Spotify OAuth for the `read`, `write`, and `player`
  scopes, each with its own token cache. Exposes `auth_status()` and
  `access_token()` (auto-refreshing).
- `db.py` — all Postgres queries behind the API (playlist list, stats, rows,
  curation pool, save, editing a curated playlist's tracks in place,
  missing-metadata templates, playlist tracks for the player), plus the
  library-intelligence helpers: `find_similar` (nearest-neighbour over the
  normalized audio-feature vector), `duplicates` (group by ISRC), `library_health`
  (coverage counts), saved-filter CRUD, and `playlist_mirror` (for re-sync diffs).
- `jobs.py` — an in-memory registry that runs the CLI scripts as subprocesses and
  captures their output line-by-line.
- `main.py` — the FastAPI app: status/auth endpoints, job endpoints (start +
  Server-Sent-Events log stream), DB-data endpoints, curation, the player token +
  playlist-tracks endpoints (`PUT /api/playlists/{id}/tracks` to replace a curated
  playlist's tracks), the re-sync diff (`GET /api/playlists/{id}/resync`), and the
  library-intelligence endpoints (`/api/tracks/similar`, `/api/duplicates`,
  `/api/library-health`, `/api/saved-filters`).

The backend wraps the **same scripts** the CLI uses, so the web and terminal
paths behave identically.

### Frontend (`web/frontend/`)
A React SPA with four tab pages (`Run pipeline`, `Curate`, `Dashboard`,
`Player`). `src/api/client.ts` is a thin fetch wrapper over `/api`;
`react-query` handles fetching and caching. Curation logic (Camelot parsing,
transition cost, vibe grouping, sort strategies) lives in `src/lib/curate.ts`.
Vite proxies `/api` to the backend in development. The UI follows the Spotify
desktop app's visual language — a dark left sidebar, a rounded content panel, the
Spotify-green accent, and the Montserrat typeface — with all design tokens defined
once in `src/index.css`.

Playback is built on a single Web Playback SDK controller shared across the app:
`src/lib/playback.ts` holds the SDK controller singleton (so playback survives tab
switches and is the same everywhere), `src/hooks/usePlayback.ts` subscribes a
component to it and exposes the state plus controls (including the position
extrapolated locally between the SDK's state events), and
`src/components/ui/NowPlayingBar.tsx` renders the controls and the seekable
progress bar. `GlobalNowPlaying`, mounted once in `App.tsx`, uses these to show a
floating now-playing panel on **every tab** (collapsed to a chip, expanding on
hover/focus); the Player and Curate pages reuse the same hook to drive their play
buttons and highlight the current track.

## Data flow

### Export (Spotify → DB)
`spotify_playlist_export.py` reads selected playlists via the Spotify API. Each
playlist becomes a `playlists` row (`spotify_id` set, `curated = FALSE`). Each
track is **upserted** into `tracks` keyed on `spotify_uri` (so a track shared by
several playlists is stored once), its artists are upserted and linked via
`track_artists`, and membership + order is recorded in `playlist_tracks`.
Playlists are **never merged**.

### Enrichment (incremental)
- **Countries** — for artists still missing a `country_code` (or a chosen
  playlist scope), query MusicBrainz, cache results in
  `musicbrainz_artist_cache.json`, and write `country_code` / `country_name` /
  `country_status` onto `artists`.
- **Features** — for feature-less tracks, run a **pluggable provider**
  (`scripts/feature_providers.py`): `freqblog` (batch audio features, the default)
  or `lastfm` (genre/mood tags). Each provider implements `available()` +
  `enrich()`; `enrich_spotify_csv.py --provider <name>` selects one and writes with
  the matching `feature_source`. New sources plug in by adding a class to the
  registry — the pipeline no longer depends on any single source.
- **Local analysis** — match remaining feature-less tracks to files in an audio
  folder, analyse with `librosa`, write with `feature_source = local-estimate`.
- **Manual import** — `import_manual.py` reads hand-filled JSON (the templates the
  Dashboard/Run-pipeline download produces), matches by id or name/URI, and writes
  with a `manual` status/source, ignoring blank fields.

Re-running any enrich step skips rows that already have the data, unless `--all`.

### Curation and playback
Curation reads the track pool for the selected playlists from `db.curate_tracks`,
filtering/grouping/ordering entirely in the browser. **Save** writes a new
`playlists` row with `curated = TRUE` (`spotify_id` NULL) plus ordered
`playlist_tracks`. Optionally, `create_spotify_playlist.py` pushes that DB
playlist to Spotify as a private playlist in order. The shared playback controller
fetches a short-lived access token from the backend and drives the Web Playback
SDK, queueing tracks by their `spotify_uri` — so curated (DB-only) and exported
playlists play the same way, and a track started from the Player or from Curate's
"Your playlist" panel is controlled from the same floating now-playing panel on
every tab.

The Player can also **edit a curated playlist in place**: removing tracks,
dragging to reorder, and undoing, then saving sends the URIs to
`PUT /api/playlists/{id}/tracks`, which rewrites that playlist's `playlist_tracks`
rows in the new order (restricted to `curated = TRUE` playlists; exported ones are
read-only). **Push to Spotify** saves any pending edits, then runs
`create_spotify_playlist.py`; when the DB row already carries a
`spotify_playlist_id`, `--update` replaces that Spotify playlist's items in place
instead of creating a new one (the script records the id on first create). For
**exported** playlists the Player diffs the DB mirror against the live Spotify
playlist (`GET /api/playlists/{id}/resync`) and can re-import to reconcile drift.

The playback controller also extends the queue automatically as a long playlist
nears the end of its current window (appending via Spotify's queue endpoint), and
exposes volume/mute, shuffle, repeat, and device-transfer, all driven from the
floating now-playing panel. A global key handler (in `GlobalNowPlaying`) maps
Space / arrows to play-pause / seek / volume. Curation similarly supports undo,
an energy-curve ordering, saved filters (`saved_filters` table), and
"more like this" via `find_similar`.

## Database schema

The baseline is in `db/schema.sql` (applied when the Docker Postgres first boots,
or via `scripts/db_init.py`; idempotent). Incremental changes live in
`db/migrations/*.sql` and are applied by `scripts/db_migrate.py`, which records
each applied version in a **`schema_migrations`** table and re-runs the baseline
safely. Run it after pulling changes that add columns.

### `tracks`
One row per track, deduplicated by `spotify_uri` (the natural upsert key). Holds
base fields (`title`, `artists_text`, `album`, `album_art_url`, `duration_ms`,
`isrc`, `release_date`, `explicit`, …) and all audio-feature columns (`bpm`,
`key`, `mode`, `camelot`, `open_key`, `energy`, `loudness_db`, `danceability`,
`valence`, `speechiness`, `instrumentalness`, `liveness`, `acousticness`,
`time_signature`, `mood`, `genre`). `feature_source` records provenance
(`freqblog` / `lastfm` / `local-estimate` / `manual`); `updated_at` tracks last
change. `album_art_url` is captured during export.

### `artists`
One row per artist (`name` UNIQUE), with `country_code` (ISO alpha-2),
`country_name`, and `country_status` (MusicBrainz match quality). "Greek" in the
app means `country_code = 'GR'`.

### `playlists`
One row per playlist. Exported playlists have `spotify_id` set; in-app curated
playlists have `curated = TRUE` and `spotify_id` NULL. `spotify_playlist_id` holds
the id of the Spotify playlist a push created, enabling update-in-place.

### `saved_filters`
Persisted Curate filter rules ("smart playlists"): `name` + a JSONB `rules`
blob (search text, category selections, numeric ranges) that the UI re-applies.

### `track_artists` (M:N)
Links tracks to their credited artists with `position` (0 = primary). Cascades on
delete.

### `playlist_tracks` (M:N)
Links playlists to their tracks with `position` (order within the playlist). A
track can belong to many playlists; cascades on delete.

### Relationships

```
artists 1 ──< track_artists >── N tracks N ──< playlist_tracks >── 1 playlists
```

Indexes cover the foreign keys plus `tracks.isrc`, `tracks.feature_source`, and
`artists.country_code` to keep the dashboard and enrichment lookups fast.

## Testing & CI

- **Frontend** — Vitest covers the pure curation logic in `src/lib/curate.ts`
  (Camelot parsing, transition cost, sort strategies incl. the energy curve, vibe
  grouping). Run with `npm test` in `web/frontend`.
- **Backend** — pytest (`web/backend/tests/`) exercises the `db.py` query helpers
  and runs API smoke tests through FastAPI's `TestClient`. A session fixture
  creates, seeds, and drops an isolated `mixloom_test` database against the same
  Postgres server, so real data is untouched (the suite skips if no server is up).
- **CI** — `.github/workflows/ci.yml` runs on push/PR: the frontend job
  type-checks, builds, and runs Vitest; the backend job lints with `ruff`
  (`ruff.toml`), applies migrations against a throwaway Postgres service, and runs
  pytest (deps from `requirements-ci.txt`).
- **Docker** — `docker-compose.yml` at the repo root builds and runs all three
  services (db, backend, frontend); the backend image applies migrations on boot.

## Security & privacy notes

- Spotify tokens live only in backend-side cache files
  (`.spotify_token_cache`, `.spotify_playlist_create_token_cache`,
  `.spotify_player_token_cache`); the browser only ever receives a short-lived
  player access token when it connects the SDK.
- The only writes to your Spotify account are creating new **private** playlists
  and controlling playback on your own device.
- Database contents live in a Docker volume (`spotify_meta_data`), outside the
  repo and git.
