# Prompt: Fullstack web app for the Spotify playlist tools

> Hand this file to a coding agent. It is self-contained: it embeds the existing
> scripts' behavior, env vars, and CSV schema so the agent need not rediscover them.

---

You are building a local-first fullstack web app on top of an existing Python project at `/home/greg/projects/spotify-api-test`. Read that repo first, especially the four scripts and `README.md`. **Do not modify the existing Python scripts' behavior** — wrap them. Everything runs locally for a single user on Linux/WSL.

## What exists today

Four Python scripts (CLI, use a `.env` file via `python-dotenv`):

1. **`spotify_playlist_export.py`** — Spotify OAuth (read scopes `playlist-read-private playlist-read-collaborative`, token cache `.spotify_token_cache`). Lists the user's playlists, exports selected ones to per-playlist CSVs plus a deduplicated `merged_playlists.csv` in `spotify_exports/`. CLI: no args (interactive select) or comma-separated playlist IDs. Base CSV columns: `position, title, artists, artist_names_json, album, duration_ms, isrc, spotify_url, spotify_uri, source_playlists`.
2. **`enrich_artist_countries.py`** — MusicBrainz lookups per credited artist. Needs `CONTACT_EMAIL`. CLI: optional input CSV path (default `spotify_exports/merged_playlists.csv`); writes `<stem>_countries.csv`. Uses `musicbrainz_artist_cache.json`; rate-limited (~1.1s/artist, so runs can take minutes). Adds columns: `artist_countries, artist_country_codes, artist_country_details, artist_country_status, greek_artist`.
3. **`enrich_spotify_csv.py`** — FreqBlog bulk-CSV audio features. Needs `FREQBLOG_API_KEY`. CLI: optional input CSV path; writes `<stem>_enriched.csv`. Adds columns: `found, itunes_track_id, mbid, album_name, release_date, explicit, bpm, bpm_confidence, key, key_confidence, mode, camelot, open_key, energy, loudness_db, danceability, valence, speechiness, instrumentalness, liveness, acousticness, time_signature, mood, genre, feature_source`.
4. **`create_spotify_playlist.py`** — Spotify OAuth write scope (`playlist-modify-private`, token cache `.spotify_playlist_create_token_cache`). Creates a private playlist from a CSV's `spotify_uri`/`spotify_url` column. CLI: CSV path + playlist name.

`.env` keys: `SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET, SPOTIPY_REDIRECT_URI, FREQBLOG_API_KEY, CONTACT_EMAIL`. All CSVs are UTF-8 with BOM (`utf-8-sig`). There is already a Streamlit app (`app.py`) that demonstrates the intended dashboard — use it as the reference for which statistics to show, then replace it with this web app.

## Goal

A fullstack web app that (a) runs the four scripts from the UI with **live-streaming logs and progress**, and (b) provides a **live dashboard** over any exported CSV with summary statistics and charts.

## Stack (use these)

- **Backend: Python + FastAPI** (reuse the existing scripts; backend holds all secrets). Serve REST + Server-Sent Events. Run it from the project's existing venv so `spotipy`, `pandas`, etc. are available.
- **Frontend: React + TypeScript + Vite.** TanStack Query for data, a charting lib of your choice (Recharts or ECharts), a component/styling setup of your choice (e.g. Tailwind + shadcn/ui). Live logs via `EventSource` (SSE).
- Put the app in a new subfolder (`web/` with `web/backend` and `web/frontend`), don't scatter it in the repo root. Add a root `README` section for running it, and a way to start both (e.g. a dev script or docker-compose, your call).

## Backend requirements

- **Never expose `.env` secrets to the frontend.** Expose only a status endpoint reporting which keys are set (booleans, no values).
- **Run scripts as async background jobs** with an in-memory job registry: `{id, type, status(pending|running|succeeded|failed), args, returncode, startedAt, finishedAt}`. Invoke each script with the venv's Python as a subprocess (`sys.executable <script> <args>`), capture merged stdout/stderr line-by-line, and expose a **live log + status stream over SSE**. Preserve each script's own progress output. Enrichment jobs are long; the stream must update incrementally and survive until completion.
- **Spotify OAuth must use a proper server-side web redirect flow** (not spotipy's local-browser popup): a login endpoint that redirects to Spotify's authorize URL, a callback endpoint on the backend that exchanges the code and writes the same token caches the scripts use (`.spotify_token_cache` for read, `.spotify_playlist_create_token_cache` for write), and a status endpoint. The redirect URI must match `SPOTIPY_REDIRECT_URI` — document that the user must register the backend's callback URL in their Spotify app settings. Read and write scopes are separate; handle both.
- **Dashboard data**: parse CSVs with pandas. Endpoints to list CSVs in `spotify_exports/` (name, rows, mtime, which column groups are present), fetch aggregated stats, and fetch raw rows (paginated) for a table. Compute stats server-side.

Suggested endpoints: `GET /api/status`; `GET /api/auth/spotify/login?scope=read|write`, `GET /api/auth/spotify/callback`, `GET /api/auth/status`; `GET /api/spotify/playlists`; `POST /api/jobs/{export|enrich-countries|enrich-features|create-playlist}` → `{jobId}`; `GET /api/jobs`, `GET /api/jobs/{id}`, `GET /api/jobs/{id}/stream` (SSE); `GET /api/files`, `GET /api/files/{name}/stats`, `GET /api/files/{name}/rows`.

## Frontend requirements

**Design and components (required):** modern, polished UI. Clean visual hierarchy, consistent spacing and typography, light/dark mode, responsive down to phone width, subtle motion, accessible (keyboard, ARIA, sufficient contrast). Build from **small reusable components** with a shared design-token system (colors, spacing, radius, typography): e.g. `Button`, `Card`, `Stat`/`MetricTile`, `Badge`, `Select`, `MultiSelect`, `Tabs`, `LogPanel`, `ChartCard`, `DataTable`, `StatusPill`, `EmptyState`. No copy-pasted markup; compose pages from these primitives. Keep styling consistent across every view.

Two areas:

**Run pipeline** — a card per step. Export (fetch playlists, multiselect, run), Country enrichment and Audio-feature enrichment (choose an input CSV from `spotify_exports/`, run), Create playlist (choose CSV + name). Each run opens a live log panel (SSE) showing streamed output and final status. Show auth state and a "Connect Spotify" action for each scope; show which `.env` keys are configured.

**Dashboard** — pick any CSV, then render (charts appear only for column groups the CSV actually has):
- Metrics: total tracks, unique artists (parse `artist_names_json`, fallback split `artists`), unique albums, total duration (sum `duration_ms`), % Greek (`greek_artist == "Yes"`), median `bpm`.
- Top artists; tracks per source playlist (from `source_playlists`, strip the ` [id]` suffixes).
- Countries: top `artist_country_codes` (split `;`), `greek_artist` breakdown, `artist_country_status` breakdown.
- Audio: FreqBlog match rate (`found == "true"`), histograms for `bpm` and selectable features (`energy, danceability, valence, acousticness, loudness_db`, …), and bar charts for `camelot`, `genre`, `mood`.
- A paginated raw-data table with search.

The dashboard should refresh when a job that writes a CSV finishes.

## Constraints & acceptance

- No secrets reach the client; `.env`, token caches, `musicbrainz_artist_cache.json`, and `spotify_exports/` stay git-ignored (follow the existing `.gitignore`).
- Don't change the four scripts' logic; only add a thin backend wrapper around them.
- Handle failures gracefully (missing env keys, missing auth, script non-zero exit, no CSVs yet) with clear UI messages.
- Modern design and a reusable component library as described above are part of the definition of done.
- Provide a one-command (or documented two-command) local run, and a short README covering setup, the Spotify redirect-URI registration step, and how to run backend + frontend.
- Acceptance: with valid `.env` + Spotify auth, a user can export → enrich (watching live logs) → view the dashboard for the enriched CSV → create a playlist, entirely from the browser, in a clean modern interface built from reusable components.
