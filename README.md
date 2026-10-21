# Spotify Playlist Tools

Build and understand Spotify playlists from richer metadata than Spotify exposes
in its own app. Export your playlists into a local **Postgres** database, enrich
the tracks with artist-country data (MusicBrainz) and audio features (FreqBlog or
local audio analysis), then **curate** new playlists with metadata filters, "vibe"
grouping, and DJ-style key/tempo ordering — and **play** them in the browser.

You can use everything **two ways**:

- **Web app** in `web/` — a four-tab UI (Run pipeline · Curate · Dashboard ·
  Player) with live job logs and charts. This is the primary interface.
- **CLI scripts** in `scripts/` — run each pipeline step ad hoc from a terminal.

Both share the same `.env`, the same Postgres database, and the same Spotify
token caches, so you can mix and match freely.

> **New here?** See [`docs/overview.md`](docs/overview.md) for what the app does
> and every capability, and [`docs/architecture.md`](docs/architecture.md) for
> how it's built and the data model.

## Repository layout

```text
scripts/                       CLI tools (each runnable on its own)
  spotify_playlist_export.py     export selected playlists -> Postgres (no merge)
  enrich_artist_countries.py     add artist country via MusicBrainz -> DB
  enrich_spotify_csv.py          add audio features via FreqBlog -> DB
  analyze_local_audio.py         estimate features from local audio files -> DB
  create_spotify_playlist.py     create a private Spotify playlist from a DB playlist
  import_manual.py               import hand-filled metadata JSON -> DB
  db_init.py                     create the DB and apply the schema (idempotent)
  db_import.py                   seed the DB from an existing exported CSV
  dbutil.py                      shared DB helpers (connection, upserts, coercion)
db/
  schema.sql                     table definitions (tracks, artists, playlists, links)
  docker-compose.yml             local Postgres 16 (auto-applies schema on first boot)
web/
  backend/                       FastAPI app: wraps the scripts, serves DB data
  frontend/                      React + TypeScript + Vite UI
  dev.sh                         start backend + frontend together (+ DB check)
docs/                           overview and architecture documentation
requirements.txt               Python deps for scripts + backend (one venv)
.env / .env.example            credentials + DATABASE_URL (real .env is git-ignored)
```

The scripts resolve `.env`, the caches, and `db/schema.sql` relative to the repo
root, so they work no matter which directory you run them from.

## 1. Prerequisites

- Python 3.10+
- Node.js 18+ and npm (for the web app)
- Docker (for the local Postgres database) — or any reachable Postgres 16
- A Spotify account and a [Spotify Developer app](https://developer.spotify.com/dashboard/)
- **Spotify Premium** — only for the in-browser Player tab
- A FreqBlog API key — only for FreqBlog audio-feature enrichment
- `ffmpeg` — only for local audio analysis of `.mp3`/`.m4a` files
- Internet access

MusicBrainz needs no API key, only a contact email sent in its User-Agent.

## 2. Setup

### 2.1 Python environment

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Re-activate with `source .venv/bin/activate` in each new terminal.

### 2.2 Credentials (`.env`)

Copy the example and fill in real values:

```bash
cp .env.example .env
```

```dotenv
SPOTIPY_CLIENT_ID=your_spotify_client_id
SPOTIPY_CLIENT_SECRET=your_spotify_client_secret
SPOTIPY_REDIRECT_URI=http://127.0.0.1:8888/callback
FREQBLOG_API_KEY=your_freqblog_api_key
CONTACT_EMAIL=you@example.com
# Optional — defaults to the docker-compose database below:
# DATABASE_URL=postgresql://spotify:spotify@localhost:5432/spotify_meta
```

`FREQBLOG_API_KEY` is only needed for FreqBlog enrichment; `CONTACT_EMAIL` only
for country enrichment. `DATABASE_URL` is optional — it defaults to the
docker-compose database. Keep `.env` private (it is git-ignored).

### 2.3 Register the Spotify redirect URI

In your Spotify app settings, add this Redirect URI **exactly**, matching
`SPOTIPY_REDIRECT_URI`:

```text
http://127.0.0.1:8888/callback
```

This single URI serves every Spotify authorization — read (export), write
(create playlist), and player (streaming). If you change `SPOTIPY_REDIRECT_URI`,
register the new value too.

### 2.4 Start the database

```bash
docker compose -f db/docker-compose.yml up -d
```

Postgres 16 comes up on `localhost:5432` with user/password/db
`spotify`/`spotify`/`spotify_meta`, and the schema in `db/schema.sql` is applied
automatically on first boot. Data persists in a named Docker volume.

Using your own Postgres instead? Set `DATABASE_URL` in `.env` and create the
tables once with:

```bash
python scripts/db_init.py
```

## 3. Use the web app

The web app runs the pipeline steps as background jobs with live-streaming logs,
and serves the Curate, Dashboard, and Player tabs from the database.

### 3.1 Install the frontend (first time)

```bash
cd web/frontend
npm install
cd ../..
```

### 3.2 Run

```bash
./web/dev.sh
```

It checks the database is reachable, then starts the FastAPI backend (default
`http://127.0.0.1:8888`, read from `SPOTIPY_REDIRECT_URI`) and the Vite frontend
(`http://localhost:5173`). Open the frontend URL. Stop both with `Ctrl+C`.

> Open the frontend via `localhost` or `127.0.0.1`. The Player tab uses Spotify's
> Web Playback SDK, which only runs in a secure context — a bare LAN IP won't work.

To run them separately:

```bash
# Backend
.venv/bin/python -m uvicorn main:app --app-dir web/backend --host 127.0.0.1 --port 8888 --reload

# Frontend
cd web/frontend && npm run dev
```

The frontend proxies `/api` to the backend, so you only open the frontend URL.

### 3.3 The four tabs

- **Run pipeline** — a card per step. **Export** (connect Spotify read, refresh
  and pick playlists) downloads them into the DB. **Enrich artist countries** and
  **Enrich audio features** target selected playlists (or all) and run only on
  rows still missing that metadata; each card shows a "missing / total" count and
  can download a JSON template of the rows still missing, to fill by hand.
  **Analyse downloaded files** estimates features from a local audio folder for
  tracks the APIs couldn't fill. **Create playlist** pushes a DB playlist to
  Spotify (needs write access). Every run opens a live log panel.
- **Curate** — build a new playlist from metadata already in the DB. Multi-select
  source playlists (duplicates removed across them), then **pick tracks manually**
  with a filter per metadata field (genre, mood, Camelot key, Greek, album text,
  and BPM/energy/valence/danceability/acousticness/duration ranges) or
  **auto-group by vibe** (energy × mood quadrants, tempo bands, Partying
  Greek/non-Greek, FreqBlog mood, or genre). Order the selection for smooth
  DJ-style transitions (greedy Camelot + BPM + energy), a plain BPM/energy ramp,
  or by hand with drag-and-drop — with per-track key/BPM/energy chips and a
  mix-quality dot between tracks. Save to the DB, and with write access create the
  private Spotify playlist in that exact order.
- **Dashboard** — pick one playlist or the whole library and view metrics (tracks,
  unique artists, albums, duration, % Greek, median BPM), top artists, tracks per
  source playlist, country/Greek/lookup-status breakdowns, audio-feature
  histograms and category charts, and a searchable paginated table. Sections
  appear only for the metadata the selection actually has.
- **Player** — connect Spotify (player scope, **Premium required**) and play your
  DB playlists — both exported and ones you curated — in the browser. Per-track
  and "play all" buttons, a now-playing bar (prev / play-pause / next), and
  playback that keeps going while you switch tabs.

## 4. Use the CLI scripts

Run from the repo root. Spotify authorization opens a browser on first use for
each scope; the token is cached so later runs are non-interactive. All scripts
accept `--database-url` to override `DATABASE_URL`.

```bash
# Export playlists into the DB (interactive picker, or pass playlist IDs)
python scripts/spotify_playlist_export.py
python scripts/spotify_playlist_export.py 37i9dQ...,2lb8e...

# Enrich artist countries (all artists missing a country, or scope to playlists)
python scripts/enrich_artist_countries.py
python scripts/enrich_artist_countries.py --playlists 1,2,3
python scripts/enrich_artist_countries.py --all      # re-resolve everything

# Enrich audio features from FreqBlog (feature-less tracks only, by default)
python scripts/enrich_spotify_csv.py
python scripts/enrich_spotify_csv.py --playlists 1,2,3

# Estimate features from local audio files (for tracks the APIs couldn't fill)
python scripts/analyze_local_audio.py /path/to/audio --playlists 1,2,3
python scripts/analyze_local_audio.py /path/to/audio --seconds 0   # whole file

# Create a private Spotify playlist from a DB playlist (by its DB id)
python scripts/create_spotify_playlist.py 5 "My New Playlist"

# Import hand-filled metadata JSON (type auto-detected) back into the DB
python scripts/import_manual.py artists_missing_country.json
python scripts/import_manual.py tracks_missing_features.json
```

Incremental by design: the enrich steps only touch rows still missing that
metadata unless you pass `--all`. Country lookups are cached in
`musicbrainz_artist_cache.json` and rate-limited (~1.1s per new artist), so large
libraries take minutes the first time and are fast afterward.

To migrate data from an older CSV export into the DB, use `scripts/db_import.py`
(see its `--help`).

## 5. Data model

All metadata lives in Postgres. See [`docs/architecture.md`](docs/architecture.md)
for the full schema; in short:

- **`tracks`** — one row per track (deduplicated by `spotify_uri`), with base
  fields and all audio-feature columns; `feature_source` records where the
  features came from (`freqblog`, `local-estimate`, or `manual`).
- **`artists`** — one row per artist (unique name) with `country_code` /
  `country_name` / `country_status`.
- **`playlists`** — exported playlists (`spotify_id` set) and in-app curated ones
  (`curated = TRUE`); tracks are kept distinct, never merged.
- **`track_artists`** and **`playlist_tracks`** — ordered many-to-many links.

## 6. Data and privacy

Secrets never reach the browser; the backend holds all tokens. Only
`create_spotify_playlist.py` (and the Player's playback control) writes to your
Spotify account, and it only creates new private playlists.

These are git-ignored and should stay private:

```text
.env
.spotify_token_cache
.spotify_playlist_create_token_cache
.spotify_player_token_cache
musicbrainz_artist_cache.json
```

The Postgres data lives in a Docker volume (`spotify_meta_data`), not in the repo.

## 7. Troubleshooting

- **"Missing .env variables"** — a required key is unset; see section 2.2.
- **Backend errors / "Loading…" never finishes** — the database isn't reachable.
  Start it with `docker compose -f db/docker-compose.yml up -d`; `web/dev.sh`
  prints a reachability check on startup.
- **Spotify 403 / no playlists** — check your app's Developer Mode settings and
  that the account is allowed; re-authorize if needed.
- **Player shows "Premium required" or won't play** — the Web Playback SDK needs
  a Spotify Premium account and a secure context; open the app via `localhost`.
- **Country enrichment is slow** — expected; MusicBrainz is rate-limited. The
  local cache makes later runs fast.
- **Local analysis can't decode a file** — install `ffmpeg` for `.mp3`/`.m4a`
  (`.wav`/`.flac`/`.ogg` decode without it).
- **OAuth redirect mismatch** — the registered Redirect URI must equal
  `SPOTIPY_REDIRECT_URI` exactly.
