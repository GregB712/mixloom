# Spotify Playlist CSV Tools

Four Python scripts to export Spotify playlists to CSV, enrich tracks with audio-feature metadata from FreqBlog, look up the associated countries of every credited artist using MusicBrainz, and build a new Spotify playlist from an exported CSV.

These scripts do not download or analyze audio files and do not modify existing Spotify playlists. The exporter and the enrichment scripts read playlist contents and read and write CSV files; the playlist builder creates a new private playlist from a CSV.

## Contents

- `spotify_playlist_export.py` — authenticate with Spotify, select one or more playlists, export each selected playlist to its own CSV, then create a merged CSV with duplicate tracks removed and rows sorted by title and artist.
- `enrich_artist_countries.py` — look up all credited artists on every track using MusicBrainz, cache results locally, and append country and Greek-artist classification columns.
- `enrich_spotify_csv.py` — submit CSV rows to the FreqBlog bulk CSV endpoint and append the feature columns returned by that service, such as BPM, key, Camelot key, energy, and other fields when available.
- `create_spotify_playlist.py` — read Spotify track URIs from an exported CSV and create a new private playlist from them. This is the only script that writes to your Spotify account; it requests the `playlist-modify-private` scope and uses a separate token cache.

## 1. Requirements

- Python 3.10 or newer.
- A Spotify account and a Spotify Developer app for playlist export.
- A FreqBlog API key for audio-feature enrichment.
- Internet access for API requests.

MusicBrainz does not require an API key for the kind of artist lookup performed here. Its service asks clients to identify themselves with a valid User-Agent and to observe its request rate limit.

## 2. Create the Python environment (Linux/Ubuntu)

Open a terminal in the directory where you want to keep the project. If Python and virtual-environment support are not installed, run:

```bash
sudo apt update
sudo apt install python3 python3-venv python3-pip
```

Unzip the downloaded package or place the three scripts and this README in a project folder. Then enter that folder and create a virtual environment:

```bash
cd spotify_ai_dj_scripts
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Whenever you open a new terminal, activate the environment again:

```bash
cd /path/to/spotify_ai_dj_scripts
source .venv/bin/activate
```

Replace `/path/to/spotify_ai_dj_scripts` with the actual folder location.

## 3. Configure Spotify API access

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/) and sign in with the Spotify account you want to use.
2. Create an app, for example `Spotify CSV Exporter`.
3. In the app settings, add this Redirect URI exactly:

   ```text
   http://127.0.0.1:8888/callback
   ```

4. Save the setting and copy the app's Client ID and Client Secret.
5. Check Spotify's current Developer Mode requirements and endpoint access in the dashboard and documentation. Spotify account eligibility and playlist access restrictions can change.

Create a file named `.env` in the same directory as the scripts:

```dotenv
SPOTIPY_CLIENT_ID=paste_your_spotify_client_id_here
SPOTIPY_CLIENT_SECRET=paste_your_spotify_client_secret_here
SPOTIPY_REDIRECT_URI=http://127.0.0.1:8888/callback
FREQBLOG_API_KEY=paste_your_freqblog_api_key_here
CONTACT_EMAIL=your-email@example.com
```

Copy `.env.example` to `.env` as a starting point, then replace the placeholder values. Keep this file private. Do not send it to anyone, upload it to a public repository, or include it when sharing the scripts.

The Spotify exporter requests these read permissions:

- `playlist-read-private`
- `playlist-read-collaborative`

On first run, a browser window opens for Spotify authorization. Sign in and approve the request. Spotipy stores a token cache locally so repeated runs usually do not require a fresh authorization. If you revoke access or need to reauthorize, remove `.spotify_token_cache` and run the exporter again.

## 4. Configure MusicBrainz contact information

Set `CONTACT_EMAIL` in `.env` to a real email address that can be used to contact you about the script's API requests. This identifies the script in its MusicBrainz User-Agent. `enrich_artist_countries.py` exits with an error if `CONTACT_EMAIL` is not set.

The script creates `musicbrainz_artist_cache.json` in the directory from which you run it. The cache stores successful, unknown, and ambiguous name lookups so the script does not needlessly request the same artist again. Keep this file if you want to reuse cached results. If you remove it, artist lookups will need to be made again.

## 5. Step 1 — Export Spotify playlists

Run with no arguments to list playlists visible to your Spotify account and choose which to export:

```bash
python spotify_playlist_export.py
```

At the prompt:

- Enter numbers separated by commas, such as `1,3,5`, to select particular playlists.
- Enter `all` to select every listed playlist.
- Enter `q` to cancel.

Alternatively, pass playlist IDs directly:

```bash
python spotify_playlist_export.py "PLAYLIST_ID_1,PLAYLIST_ID_2"
```

A playlist ID is the part after `/playlist/` in a Spotify playlist URL.

### Output

The script creates a `spotify_exports/` folder containing one CSV per selected playlist and a merged CSV:

```text
spotify_exports/
├── Playlist_Name__12345678.csv
├── Another_Playlist__abcdefgh.csv
└── merged_playlists.csv
```

Actual filenames use a sanitized playlist name plus a short part of its ID. The merged CSV removes duplicate tracks using the Spotify track URI where possible, retains which source playlist(s) included each track in `source_playlists`, and sorts the rows alphabetically by title and artist.

Important columns include:

- `title`, `artists`, `album`, `duration_ms`
- `artist_names_json` — JSON array containing the exact credited artist names, preserving boundaries even when a name contains a comma
- `isrc`, when supplied by Spotify
- `spotify_url`, `spotify_uri`
- `position` and `source_playlists`

Keep `artist_names_json` when passing files to the country script. It helps the script look up each artist separately. If you use an older CSV without this column, the country script falls back to parsing the comma-separated `artists` value, which can be ambiguous for artist names containing commas.

## 6. Step 2 — Enrich the CSV with artist countries

Run the country enrichment script against the merged export:

```bash
python enrich_artist_countries.py
```

With no argument, it reads `spotify_exports/merged_playlists.csv`. You can provide a different file path:

```bash
python enrich_artist_countries.py "spotify_exports/Playlist_Name__12345678.csv"
```

The script queries MusicBrainz for every distinct credited artist on each track. Repeated artists use the local cache rather than triggering another lookup. Requests are rate-limited to avoid sending queries too quickly.

### Output

The input file is not overwritten. The output file is named by adding `_countries` before `.csv`:

```text
spotify_exports/merged_playlists_countries.csv
```

Added columns:

- `artist_countries` — distinct country names across credited artists
- `artist_country_codes` — distinct country codes, such as `GR`
- `artist_country_details` — country and lookup status per artist
- `artist_country_status` — `complete`, `partial`, `ambiguous`, or `unknown`
- `greek_artist` — `Yes` if any matched artist is associated with Greece, `No` if all artists have known non-Greek associated countries, otherwise `Unknown`

MusicBrainz's country is an artist's associated/main country in its database; it is not guaranteed to represent nationality or citizenship. `Unknown` means the source data did not support a reliable classification. An ambiguous or missing match should not be interpreted as proof that an artist is not Greek.

## 7. Step 3 — Enrich the CSV with audio features

Make sure `FREQBLOG_API_KEY` is set in `.env`, then run:

```bash
python enrich_spotify_csv.py
```

With no argument, this reads `spotify_exports/merged_playlists.csv`. To enrich the CSV that already contains country columns, pass its path:

```bash
python enrich_spotify_csv.py "spotify_exports/merged_playlists_countries.csv"
```

The script sends the rows to FreqBlog's bulk CSV endpoint in batches of up to 500 rows. It uses the first credited artist and title for matching, preferring `artist_names_json` where available. It retries rows marked as still processing, then retains rows that remain pending or are not found. The original CSV is never overwritten.

The resulting filename adds `_enriched` to the input's basename. For the country-enriched file above, it is:

```text
spotify_exports/merged_playlists_countries_enriched.csv
```

FreqBlog's returned field names and available features depend on its service and track matching. The output appends returned columns; possible fields include BPM/tempo, standard key, Camelot notation, mode, energy, danceability, acousticness, instrumentalness, loudness and valence. Some values may be unavailable, estimated, or not returned. The script does not infer missing values itself. Review `found`, `backfill_status`, and any reason/status fields returned by the API to understand unsuccessful or pending matches.

The API plan's quota and billing rules may change. Check the current FreqBlog account/dashboard before processing a large library. The script submits rows in batches, but a batch does not necessarily count as one API request for quota purposes.

## 8. Optional — Create a Spotify playlist from a CSV

`create_spotify_playlist.py` reads Spotify track URIs from any exported CSV and creates a new private playlist in your account. It needs the `spotify_uri` column (or falls back to extracting the track ID from `spotify_url`).

Because it writes to your account, it requests the `playlist-modify-private` scope and uses a separate token cache (`.spotify_playlist_create_token_cache`), so Spotify prompts for the new permission on first run.

```bash
python create_spotify_playlist.py "spotify_exports/merged_playlists.csv" "My New Playlist"
```

With no arguments, it prompts for the CSV path and playlist name. It shows a summary and asks for confirmation before creating anything. Tracks are added in batches of 100, preserving CSV order.

## 9. Recommended complete workflow

To produce one file containing Spotify metadata, artist-country information, and the audio features returned by FreqBlog, run these commands in order:

```bash
# 1. Export and select playlists
python spotify_playlist_export.py

# 2. Add MusicBrainz artist-country information
python enrich_artist_countries.py

# 3. Add FreqBlog metadata to the country-enriched CSV
python enrich_spotify_csv.py "spotify_exports/merged_playlists_countries.csv"
```

The combined result is:

```text
spotify_exports/merged_playlists_countries_enriched.csv
```

You can reverse the two enrichment steps if preferred: the country script can also process the audio-enriched CSV, producing `merged_playlists_enriched_countries.csv`. Both enrichment scripts retain the columns already present in the input.

## 10. Troubleshooting

### `Missing .env variables`

Check that `.env` is in the current working directory, that variable names are exact, and that values have no extra quotation marks or spaces. The scripts load `.env` relative to the directory where they are run.

### Spotify authorization or HTTP 403 errors

Verify the Client ID, Client Secret, and Redirect URI. Confirm that the Spotify app meets the current Development Mode requirements and that the playlist is accessible to the authorized account. Spotify can restrict playlist reads by playlist ownership/collaboration and by app access. A playlist can be visible in Spotify but inaccessible through the API.

If changing scopes does not trigger a new consent screen, remove `.spotify_token_cache` and authenticate again.

### `FREQBLOG_API_KEY is missing`

Check the `.env` file and make sure the key is assigned to `FREQBLOG_API_KEY` exactly. If a request is rejected, verify that the key is valid and that you have remaining quota.

### Missing audio features or tracks marked not found

The service may not have a match for every track, or may return pending/unavailable statuses. The script retains the row and appends status fields returned by the API where available. Re-running may use more quota; check the provider's retry guidance and current plan first.

### Country script stops on a network error

The script saves the country cache after each new artist. Fix the network/API issue and rerun the same command. Already-cached artist lookups are reused. A slow run is expected for many unique artists because requests are rate-limited.

### Script cannot find the input CSV

Run from the project directory or pass the full/relative path to the CSV as the first argument. Quote file paths containing spaces.

## 11. Protect local credentials and caches

Do not share `.env`, `.spotify_token_cache`, `.spotify_playlist_create_token_cache`, or other token/cache files. This repository already includes a `.gitignore` covering them:

```gitignore
.env
.spotify_token_cache
.spotify_playlist_create_token_cache
musicbrainz_artist_cache.json
spotify_exports/
.venv/
__pycache__/
```

CSV exports contain your playlist information, so `spotify_exports/` is git-ignored by default. Only `spotify_exports/.gitkeep` is tracked, to preserve the folder. Remove the `spotify_exports/` line from `.gitignore` if you deliberately want to commit exports.
