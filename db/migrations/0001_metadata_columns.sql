-- Columns and tables added after the initial schema.
--   tracks.album_art_url      — album cover captured during export (Spotify CDN URL)
--   playlists.spotify_playlist_id — the Spotify id of the playlist created by a push,
--                                   so a push can update that playlist in place
--   saved_filters             — persisted Curate filter rules ("smart playlists")
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

ALTER TABLE tracks    ADD COLUMN IF NOT EXISTS album_art_url       TEXT;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS spotify_playlist_id TEXT;

CREATE TABLE IF NOT EXISTS saved_filters (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    rules       JSONB NOT NULL,       -- the Curate filter state (search, ranges, cats, …)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
