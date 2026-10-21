#!/usr/bin/env python3
"""Seed/refresh the Postgres metadata DB from an existing exported CSV.

Useful for migrating data you already have (e.g. the enriched merged CSV) into
the database: it recreates playlists and membership from the `source_playlists`
column, upserts tracks and artists, and applies per-artist country info parsed
from `artist_country_details`.

Usage:
    python scripts/db_import.py [input.csv] [--database-url URL]
    (default CSV: spotify_exports/merged_playlists_countries_enriched.csv)
"""

import argparse
import csv
import json
import re
from pathlib import Path

import dbutil
from dbutil import ROOT

DEFAULT_CSV = ROOT / "spotify_exports" / "merged_playlists_countries_enriched.csv"

_DETAIL_RE = re.compile(r"^(?P<name>.*)=(?P<country>.*?)\s*\[(?P<status>[^\]]*)\]$")
_SOURCE_RE = re.compile(r"^(?P<name>.*?)(?:\s*\[(?P<id>[^\]]*)\])?$")


def artist_list(row: dict) -> list[str]:
    raw = (row.get("artist_names_json") or "").strip()
    names: list[str] = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                names = [n.strip() for n in parsed if isinstance(n, str) and n.strip()]
        except json.JSONDecodeError:
            pass
    if not names:
        names = [n.strip() for n in (row.get("artists") or "").split(",") if n.strip()]
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def country_by_artist(row: dict) -> dict[str, tuple[str | None, str | None]]:
    out: dict[str, tuple[str | None, str | None]] = {}
    for part in (row.get("artist_country_details") or "").split(";"):
        part = part.strip()
        if not part:
            continue
        m = _DETAIL_RE.match(part)
        if not m:
            continue
        country = m.group("country").strip()
        if country.lower() == "unknown":
            country = None
        out[m.group("name").strip()] = (country, m.group("status").strip() or None)
    return out


def source_playlists(row: dict) -> list[tuple[str, str | None]]:
    """Parse 'Name [id]; Name2 [id2]' into [(name, spotify_id_or_None), …]."""
    out = []
    for part in (row.get("source_playlists") or "").split(";"):
        part = part.strip()
        if not part:
            continue
        m = _SOURCE_RE.match(part)
        name = (m.group("name") or part).strip()
        sid = (m.group("id") or "").strip() or None
        out.append((name, sid))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a CSV into the metadata DB.")
    parser.add_argument("input_csv", nargs="?", default=str(DEFAULT_CSV))
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    input_path = Path(args.input_csv).expanduser()
    if not input_path.is_file():
        raise SystemExit(f"Input CSV not found: {input_path}")

    with input_path.open("r", newline="", encoding="utf-8-sig") as file:
        rows = list(csv.DictReader(file))
    if not rows:
        raise SystemExit("Input CSV contains no tracks.")
    print(f"Input: {input_path}  ({len(rows)} rows)")

    tracks = skipped = 0
    playlist_pos: dict[int, int] = {}  # playlist_id -> next position
    try:
        with dbutil.connect(args.database_url) as conn:
            with conn.cursor() as cur:
                pl_cache: dict[tuple[str, str | None], int] = {}
                for i, row in enumerate(rows, 1):
                    data = dbutil.track_values_from_csv(row)
                    if not data.get("spotify_uri"):
                        skipped += 1
                        continue
                    track_id = dbutil.upsert_track(cur, data)

                    names = artist_list(row)
                    dbutil.set_track_artists(cur, track_id, names)
                    countries = country_by_artist(row)
                    for name in names:
                        country, status = countries.get(name, (None, None))
                        if country or status:
                            aid = dbutil.get_or_create_artist(cur, name)
                            dbutil.update_artist_country(
                                cur, aid, dbutil.country_code(country), country, status)

                    for name, sid in source_playlists(row):
                        key = (name, sid)
                        if key not in pl_cache:
                            pl_cache[key] = dbutil.upsert_playlist(cur, sid, name)
                        pid = pl_cache[key]
                        pos = playlist_pos.get(pid, 0)
                        dbutil.link_playlist_track(cur, pid, track_id, pos)
                        playlist_pos[pid] = pos + 1
                    tracks += 1
                    if i % 100 == 0:
                        print(f"  …{i}/{len(rows)}")
            conn.commit()
            with conn.cursor() as cur:
                counts = {
                    t: cur.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                    for t in ("tracks", "artists", "track_artists", "playlists", "playlist_tracks")
                }
    except Exception as exc:
        raise SystemExit(
            f"Import failed (no changes committed): {exc}\n"
            "Check DATABASE_URL and that the schema exists (run scripts/db_init.py)."
        ) from exc

    print("\nFinished.")
    print(f"Tracks upserted: {tracks} | skipped (no spotify_uri): {skipped}")
    print("Row counts: " + ", ".join(f"{k}={v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
