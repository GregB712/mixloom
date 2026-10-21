-- Spotify track + artist metadata schema.
-- Idempotent: safe to run repeatedly. Also used by the Postgres Docker image
-- as an init script (mounted into /docker-entrypoint-initdb.d).

CREATE TABLE IF NOT EXISTS artists (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    country_code   TEXT,          -- ISO alpha-2 where resolvable
    country_name   TEXT,          -- e.g. "United States"; NULL when unknown
    country_status TEXT           -- MusicBrainz match status (exact/ambiguous/…)
);

CREATE TABLE IF NOT EXISTS tracks (
    id               SERIAL PRIMARY KEY,
    spotify_uri      TEXT UNIQUE,          -- natural key for upserts
    spotify_url      TEXT,
    isrc             TEXT,
    title            TEXT NOT NULL,
    artists_text     TEXT,                 -- original comma-joined credit string
    album            TEXT,
    album_name       TEXT,
    release_date     TEXT,                 -- kept as text (year / date / ISO mix)
    duration_ms      INTEGER,
    explicit         BOOLEAN,
    itunes_track_id  TEXT,
    mbid             TEXT,
    found            TEXT,

    -- Audio features (API-sourced or local-estimate; see feature_source).
    bpm              DOUBLE PRECISION,
    bpm_confidence   DOUBLE PRECISION,
    key              TEXT,
    key_confidence   DOUBLE PRECISION,
    mode             SMALLINT,
    camelot          TEXT,
    open_key         TEXT,
    energy           DOUBLE PRECISION,
    loudness_db      DOUBLE PRECISION,
    danceability     DOUBLE PRECISION,
    valence          DOUBLE PRECISION,
    speechiness      DOUBLE PRECISION,
    instrumentalness DOUBLE PRECISION,
    liveness         DOUBLE PRECISION,
    acousticness     DOUBLE PRECISION,
    time_signature   SMALLINT,
    mood             TEXT,
    genre            TEXT,
    feature_source   TEXT,

    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: a track has one or more credited artists, in order.
CREATE TABLE IF NOT EXISTS track_artists (
    track_id  INTEGER NOT NULL REFERENCES tracks(id)  ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    position  SMALLINT,               -- 0 = primary credited artist
    PRIMARY KEY (track_id, artist_id)
);

-- Playlists stay distinct (no merge); a track can belong to several.
CREATE TABLE IF NOT EXISTS playlists (
    id          SERIAL PRIMARY KEY,
    spotify_id  TEXT UNIQUE,          -- Spotify playlist id; NULL for curated-in-app
    name        TEXT NOT NULL,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER,             -- order within this playlist
    PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_track_artists_artist   ON track_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track  ON playlist_tracks(track_id);
CREATE INDEX IF NOT EXISTS idx_tracks_isrc            ON tracks(isrc);
CREATE INDEX IF NOT EXISTS idx_tracks_feature_source  ON tracks(feature_source);
CREATE INDEX IF NOT EXISTS idx_artists_country_code   ON artists(country_code);
