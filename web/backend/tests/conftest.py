"""Pytest fixtures: a throwaway Postgres database seeded with a tiny library.

The tests need a reachable Postgres server (the same one the app uses). They
create an isolated database, apply the schema + migrations, seed a handful of
rows, point `db` at it, and drop it afterwards — the real dev database is never
touched. If no server is reachable, the whole suite is skipped.
"""

import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT = BACKEND_DIR.parent.parent
sys.path.insert(0, str(BACKEND_DIR))

import config  # noqa: E402
import db  # noqa: E402

TEST_DB_NAME = "mixloom_test"


def _admin_url(base: str) -> str:
    return urlunparse(urlparse(base)._replace(path="/postgres"))


def _test_url(base: str) -> str:
    return urlunparse(urlparse(base)._replace(path=f"/{TEST_DB_NAME}"))


def _apply_sql(url: str) -> None:
    import psycopg

    schema = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    migrations = sorted((ROOT / "db" / "migrations").glob("*.sql"))
    with psycopg.connect(url) as conn:
        conn.execute(schema)
        for m in migrations:
            conn.execute(m.read_text(encoding="utf-8"))
        conn.commit()


def _seed(url: str) -> None:
    import psycopg

    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO artists (name, country_code, country_name, country_status) VALUES "
                    "('Greek One', 'GR', 'Greece', 'exact'),"
                    "('US One', 'US', 'United States', 'exact'),"
                    "('Unknown One', NULL, NULL, NULL) RETURNING id")
        # Fetch artist ids back by name (RETURNING only gives the last with multi-values on some versions).
        artists = {r[1]: r[0] for r in cur.execute("SELECT id, name FROM artists").fetchall()}

        # Tracks: two share an ISRC (duplicate), three carry features.
        tracks = [
            # uri, title, artists_text, album, isrc, bpm, energy, valence, dance, acoustic, art, source
            ("spotify:track:aaa", "Alpha", "Greek One", "A", "ISRCDUP01", 124.0, 0.8, 0.7, 0.8, 0.1, "http://art/a", "essentia"),
            ("spotify:track:bbb", "Beta", "US One", "B", "ISRCDUP01", 126.0, 0.75, 0.6, 0.7, 0.2, None, "essentia"),
            ("spotify:track:ccc", "Gamma", "US One", "C", "ISRC000002", 100.0, 0.3, 0.3, 0.4, 0.8, "http://art/c", "essentia"),
            ("spotify:track:ddd", "Delta", "Unknown One", "D", "ISRC000003", None, None, None, None, None, None, None),
        ]
        track_ids = {}
        for (uri, title, atext, album, isrc, bpm, energy, val, dance, ac, art, src) in tracks:
            cur.execute(
                "INSERT INTO tracks (spotify_uri, title, artists_text, album, isrc, bpm, energy, valence,"
                " danceability, acousticness, album_art_url, feature_source, duration_ms, camelot)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (uri, title, atext, album, isrc, bpm, energy, val, dance, ac, art, src, 200000, "8A"),
            )
            track_ids[uri] = cur.fetchone()[0]

        links = {
            "spotify:track:aaa": "Greek One",
            "spotify:track:bbb": "US One",
            "spotify:track:ccc": "US One",
            "spotify:track:ddd": "Unknown One",
        }
        for uri, aname in links.items():
            cur.execute("INSERT INTO track_artists (track_id, artist_id, position) VALUES (%s,%s,0)",
                        (track_ids[uri], artists[aname]))

        cur.execute("INSERT INTO playlists (spotify_id, name, curated) VALUES ('SP123', 'Exported', FALSE) RETURNING id")
        exported = cur.fetchone()[0]
        cur.execute("INSERT INTO playlists (name, curated) VALUES ('Curated', TRUE)")
        for pos, uri in enumerate(["spotify:track:aaa", "spotify:track:bbb", "spotify:track:ccc"]):
            cur.execute("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (%s,%s,%s)",
                        (exported, track_ids[uri], pos))
        conn.commit()


@pytest.fixture(scope="session")
def test_db():
    import psycopg

    base = config.DATABASE_URL
    try:
        with psycopg.connect(_admin_url(base), autocommit=True) as admin:
            admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)")
            admin.execute(f"CREATE DATABASE {TEST_DB_NAME}")
    except Exception as exc:  # no server reachable
        pytest.skip(f"Postgres not reachable for tests: {exc}")

    url = _test_url(base)
    _apply_sql(url)
    _seed(url)
    db.DATABASE_URL = url  # point all db helpers at the test database
    try:
        yield url
    finally:
        with psycopg.connect(_admin_url(base), autocommit=True) as admin:
            admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)")


@pytest.fixture()
def client(test_db):
    from fastapi.testclient import TestClient

    import main

    return TestClient(main.app)
