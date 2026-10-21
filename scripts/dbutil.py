"""Shared Postgres helpers for the metadata scripts (export, enrich, analyse,
import). Connection handling, value coercion, and upserts for the
tracks / artists / track_artists / playlists / playlist_tracks tables.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DEFAULT_URL = "postgresql://spotify:spotify@localhost:5432/spotify_meta"

# Audio-feature columns written by the feature/analyse steps.
FEATURE_COLUMNS = [
    "bpm", "bpm_confidence", "key", "key_confidence", "mode", "camelot",
    "open_key", "energy", "loudness_db", "danceability", "valence",
    "speechiness", "instrumentalness", "liveness", "acousticness",
    "time_signature", "mood", "genre", "feature_source",
]

# For coercing CSV strings into track-column values.
_INT_COLS = {"duration_ms", "mode", "time_signature"}
_FLOAT_COLS = {
    "bpm", "bpm_confidence", "key_confidence", "energy", "loudness_db",
    "danceability", "valence", "speechiness", "instrumentalness", "liveness",
    "acousticness",
}
_TEXT_COLS = [
    "spotify_uri", "spotify_url", "isrc", "title", "artists_text", "album",
    "album_name", "release_date", "itunes_track_id", "mbid", "found", "key",
    "camelot", "open_key", "mood", "genre", "feature_source",
]


def database_url(override: str | None = None) -> str:
    return override or os.getenv("DATABASE_URL") or DEFAULT_URL


def connect(url: str | None = None):
    import psycopg
    return psycopg.connect(database_url(url))


# --------------------------------------------------------------------------- #
# Coercion
# --------------------------------------------------------------------------- #
def nz(value) -> str | None:
    v = (str(value).strip() if value is not None else "")
    return v or None


def to_int(value) -> int | None:
    v = nz(value)
    try:
        return int(float(v)) if v is not None else None
    except ValueError:
        return None


def to_float(value) -> float | None:
    v = nz(value)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def to_bool(value) -> bool | None:
    v = (str(value).strip().lower() if value is not None else "")
    if v in ("true", "yes", "1"):
        return True
    if v in ("false", "no", "0"):
        return False
    return None


def country_code(name: str | None) -> str | None:
    if not name or name.strip().lower() == "unknown":
        return None
    try:
        import pycountry
        return pycountry.countries.lookup(name).alpha_2
    except Exception:
        return None


def coerce_feature(col: str, value) -> object:
    """Coerce an audio-feature value to its column type (int / float / text)."""
    if col in _INT_COLS:
        return to_int(value)
    if col in _FLOAT_COLS:
        return to_float(value)
    return nz(value)


def track_values_from_csv(row: dict) -> dict:
    """Coerce a CSV row into a dict of track-column values (only known columns)."""
    data: dict = {}
    for col in _TEXT_COLS:
        if col == "artists_text":
            data[col] = nz(row.get("artists"))
        else:
            data[col] = nz(row.get(col))
    for col in _INT_COLS:
        data[col] = to_int(row.get(col))
    for col in _FLOAT_COLS:
        data[col] = to_float(row.get(col))
    data["explicit"] = to_bool(row.get("explicit"))
    return {k: v for k, v in data.items() if k == "spotify_uri" or v is not None}


# --------------------------------------------------------------------------- #
# Upserts
# --------------------------------------------------------------------------- #
def upsert_track(cur, data: dict) -> int:
    """Insert or update a track by spotify_uri. Only the columns present in
    `data` are written; others are left untouched on update."""
    if not data.get("spotify_uri"):
        raise ValueError("upsert_track needs a spotify_uri")
    cols = list(data.keys())
    placeholders = ", ".join(["%s"] * len(cols))
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "spotify_uri")
    cur.execute(
        f"INSERT INTO tracks ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT (spotify_uri) DO UPDATE SET {updates}, updated_at = now() "
        f"RETURNING id",
        [data[c] for c in cols],
    )
    return cur.fetchone()[0]


def get_or_create_artist(cur, name: str) -> int:
    cur.execute(
        "INSERT INTO artists (name) VALUES (%s) "
        "ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        (name,),
    )
    return cur.fetchone()[0]


def set_track_artists(cur, track_id: int, names: list[str]) -> None:
    """Replace a track's credited-artist links, preserving order (0 = primary)."""
    cur.execute("DELETE FROM track_artists WHERE track_id = %s", (track_id,))
    for position, name in enumerate(names):
        artist_id = get_or_create_artist(cur, name)
        cur.execute(
            "INSERT INTO track_artists (track_id, artist_id, position) "
            "VALUES (%s, %s, %s) ON CONFLICT (track_id, artist_id) "
            "DO UPDATE SET position = EXCLUDED.position",
            (track_id, artist_id, position),
        )


def update_artist_country(cur, artist_id: int, code: str | None,
                          name: str | None, status: str | None) -> None:
    cur.execute(
        "UPDATE artists SET country_code = %s, country_name = %s, "
        "country_status = %s WHERE id = %s",
        (code, name, status, artist_id),
    )


def update_track_features(cur, track_id: int, feats: dict) -> None:
    cols = [c for c in FEATURE_COLUMNS if c in feats]
    if not cols:
        return
    assignments = ", ".join(f"{c} = %s" for c in cols)
    cur.execute(
        f"UPDATE tracks SET {assignments}, updated_at = now() WHERE id = %s",
        [feats[c] for c in cols] + [track_id],
    )


def upsert_playlist(cur, spotify_id: str | None, name: str,
                    curated: bool = False) -> int:
    if spotify_id:
        cur.execute(
            "INSERT INTO playlists (spotify_id, name, curated) VALUES (%s, %s, %s) "
            "ON CONFLICT (spotify_id) DO UPDATE SET name = EXCLUDED.name, "
            "updated_at = now() RETURNING id",
            (spotify_id, name, curated),
        )
    else:
        cur.execute(
            "INSERT INTO playlists (name, curated) VALUES (%s, %s) RETURNING id",
            (name, curated),
        )
    return cur.fetchone()[0]


def clear_playlist(cur, playlist_id: int) -> None:
    cur.execute("DELETE FROM playlist_tracks WHERE playlist_id = %s", (playlist_id,))


def link_playlist_track(cur, playlist_id: int, track_id: int, position: int) -> None:
    cur.execute(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) "
        "VALUES (%s, %s, %s) ON CONFLICT (playlist_id, track_id) "
        "DO UPDATE SET position = EXCLUDED.position",
        (playlist_id, track_id, position),
    )
