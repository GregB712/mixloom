#!/usr/bin/env python3
"""Import hand-filled JSON back into the database.

Accepts the files produced by the Run-pipeline download buttons
(artists_missing_country.json / tracks_missing_features.json) after you fill
them in by hand. The file type is auto-detected; override with --type.

- Artists: sets country_code / country_name (either one is enough; the other is
  derived via pycountry when possible). country_status is set to "manual".
- Tracks: sets whichever audio-feature fields you filled; feature_source is set
  to "manual" unless you provided one.

Records are matched by "id" when present, otherwise by artist name / track
spotify_uri. Blank/null fields are ignored, so partially filled files are fine.

Usage:
    python import_manual.py <file.json> [--type artists|tracks] [--database-url URL]
"""

import argparse
import json
from pathlib import Path

import dbutil
from dbutil import FEATURE_COLUMNS


def detect_type(records: list[dict]) -> str:
    for rec in records:
        if "spotify_uri" in rec or "bpm" in rec or "camelot" in rec:
            return "tracks"
        if "country_code" in rec or "country_name" in rec:
            return "artists"
    raise SystemExit("Could not detect file type; pass --type artists|tracks.")


def country_name_from_code(code: str) -> str | None:
    try:
        import pycountry
        c = pycountry.countries.get(alpha_2=code.upper())
        return c.name if c else None
    except Exception:
        return None


def import_artists(cur, records: list[dict]) -> int:
    updated = 0
    for rec in records:
        code = (rec.get("country_code") or "").strip().upper() or None
        name = (rec.get("country_name") or "").strip() or None
        if not code and not name:
            continue  # nothing filled in
        if not code and name:
            code = dbutil.country_code(name)
        if not name and code:
            name = country_name_from_code(code)

        artist_id = rec.get("id")
        if artist_id is None:
            row = cur.execute(
                "SELECT id FROM artists WHERE name = %s", (rec.get("name") or "",)
            ).fetchone()
            if not row:
                print(f"  ! artist not found: {rec.get('name')!r}")
                continue
            artist_id = row[0]
        dbutil.update_artist_country(cur, int(artist_id), code, name, "manual")
        updated += 1
    return updated


def import_tracks(cur, records: list[dict]) -> int:
    fillable = [c for c in FEATURE_COLUMNS if c != "feature_source"]
    updated = 0
    for rec in records:
        feats: dict = {}
        for col in fillable:
            if col in rec and rec[col] not in (None, ""):
                feats[col] = dbutil.coerce_feature(col, rec[col])
        feats = {k: v for k, v in feats.items() if v is not None}
        if not feats:
            continue  # nothing filled in
        feats["feature_source"] = (rec.get("feature_source") or "").strip() or "manual"

        track_id = rec.get("id")
        if track_id is None:
            row = cur.execute(
                "SELECT id FROM tracks WHERE spotify_uri = %s", (rec.get("spotify_uri") or "",)
            ).fetchone()
            if not row:
                print(f"  ! track not found: {rec.get('title')!r}")
                continue
            track_id = row[0]
        dbutil.update_track_features(cur, int(track_id), feats)
        updated += 1
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description="Import hand-filled metadata JSON into the DB.")
    parser.add_argument("input_json")
    parser.add_argument("--type", choices=["artists", "tracks"], default=None)
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    path = Path(args.input_json).expanduser()
    if not path.is_file():
        raise SystemExit(f"File not found: {path}")
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Could not read JSON: {exc}")
    if not isinstance(records, list) or not records:
        raise SystemExit("Expected a non-empty JSON array of records.")

    kind = args.type or detect_type(records)
    print(f"File: {path}  ({len(records)} records, type: {kind})")

    try:
        with dbutil.connect(args.database_url) as conn:
            with conn.cursor() as cur:
                updated = import_artists(cur, records) if kind == "artists" else import_tracks(cur, records)
            conn.commit()
    except Exception as exc:
        raise SystemExit(f"Import failed (no changes committed): {exc}")

    print(f"\nFinished. {kind} updated: {updated} | skipped (blank): {len(records) - updated}")


if __name__ == "__main__":
    main()
