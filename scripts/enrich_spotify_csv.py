#!/usr/bin/env python3
"""Fill audio-feature metadata from the FreqBlog bulk-CSV API, for tracks in the
database that don't have features yet.

Operates on the Postgres DB (not files). Optionally restrict to one or more
playlists; with no --playlists it covers every feature-less track.

Requires FREQBLOG_API_KEY in .env.

Usage:
    python enrich_spotify_csv.py [--playlists 1,2,3] [--all] [--database-url URL]
"""

import argparse
import csv
import io
import os
import time

import requests
from dotenv import load_dotenv

import dbutil
from dbutil import ROOT

load_dotenv(ROOT / ".env")

API_URL = "https://api.freqblog.com/bulk-csv"
API_KEY = os.getenv("FREQBLOG_API_KEY", "").strip()
BATCH_SIZE = 500
MAX_PROCESSING_RETRIES = 2
RETRY_DELAY_SECONDS = 35
TIMEOUT_SECONDS = 90

# Columns we send to the matcher (it keys on artist + title).
UPLOAD_FIELDS = ["title", "artist", "isrc", "spotify_uri"]


def select_tracks(cur, playlist_ids: list[int], include_all: bool) -> list[dict]:
    where = [] if include_all else ["t.feature_source IS NULL"]
    params: list = []
    if playlist_ids:
        where.append(
            "EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id "
            "AND pt.playlist_id = ANY(%s))"
        )
        params.append(playlist_ids)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    cur.execute(
        f"SELECT t.id, t.title, t.artists_text, t.isrc, t.spotify_uri "
        f"FROM tracks t{clause} ORDER BY t.id",
        params,
    )
    return [
        {"id": r[0], "title": r[1] or "", "artist": (r[2] or "").split(", ", 1)[0],
         "isrc": r[3] or "", "spotify_uri": r[4] or ""}
        for r in cur.fetchall()
    ]


def serialize_csv(rows: list[dict]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=UPLOAD_FIELDS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8-sig")


def call_bulk_csv(rows: list[dict]) -> list[dict]:
    response = requests.post(
        API_URL,
        headers={"X-Api-Key": API_KEY},
        files={"file": ("tracks.csv", serialize_csv(rows), "text/csv")},
        timeout=TIMEOUT_SECONDS,
    )
    if not response.ok:
        raise RuntimeError(f"FreqBlog returned HTTP {response.status_code}: {response.text[:800]}")
    text = response.content.decode("utf-8-sig")
    results = list(csv.DictReader(io.StringIO(text)))
    if len(results) != len(rows):
        raise RuntimeError(f"FreqBlog returned {len(results)} rows for {len(rows)} submitted.")
    return results


def is_processing(row: dict) -> bool:
    found = (row.get("found") or "").strip().lower()
    status = (row.get("backfill_status") or "").strip().lower()
    return found == "processing" or status in {"processing", "queued"}


def enrich_batch(rows: list[dict], n: int, total: int) -> list[dict]:
    results = call_bulk_csv(rows)
    for attempt in range(1, MAX_PROCESSING_RETRIES + 1):
        pending = [i for i, r in enumerate(results) if is_processing(r)]
        if not pending:
            break
        print(f"  Batch {n}/{total}: {len(pending)} pending; retry {attempt} in {RETRY_DELAY_SECONDS}s.")
        time.sleep(RETRY_DELAY_SECONDS)
        retry = call_bulk_csv([rows[i] for i in pending])
        for idx, update in zip(pending, retry):
            for k, v in update.items():
                if v not in (None, "") or k not in results[idx]:
                    results[idx][k] = v
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich audio features from FreqBlog into the DB.")
    parser.add_argument("--playlists", default="", help="comma-separated playlist ids (default: all)")
    parser.add_argument("--all", action="store_true", help="re-enrich even tracks that already have features")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    if not API_KEY:
        raise SystemExit("FREQBLOG_API_KEY is missing from your .env file.")
    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    playlist_ids = [int(p) for p in args.playlists.split(",") if p.strip()]

    try:
        conn = dbutil.connect(args.database_url)
    except Exception as exc:
        raise SystemExit(f"Could not connect to the database: {exc}")

    with conn:
        with conn.cursor() as cur:
            tracks = select_tracks(cur, playlist_ids, args.all)
            in_scope = len(select_tracks(cur, playlist_ids, True))
        scope = f"playlists {playlist_ids}" if playlist_ids else "all playlists"
        print(f"Scope: {scope}")
        if args.all:
            print(f"Tracks in scope: {in_scope} | re-enriching all (--all)")
        else:
            print(f"Tracks in scope: {in_scope} | already have features: {in_scope - len(tracks)} "
                  f"| to enrich (missing): {len(tracks)}")
        if not tracks:
            print("Nothing to do — every track in scope already has features.")
            return

        total_batches = (len(tracks) + BATCH_SIZE - 1) // BATCH_SIZE
        written = 0
        for start in range(0, len(tracks), BATCH_SIZE):
            n = start // BATCH_SIZE + 1
            batch = tracks[start:start + BATCH_SIZE]
            print(f"\nProcessing batch {n}/{total_batches} ({len(batch)} tracks)")
            try:
                results = enrich_batch(batch, n, total_batches)
            except (requests.RequestException, RuntimeError) as exc:
                conn.rollback()
                raise SystemExit(f"Batch {n} failed: {exc}\nNo changes committed.")

            with conn.cursor() as cur:
                for track, result in zip(batch, results):
                    if is_processing(result) or (result.get("found") or "").lower() == "false":
                        continue
                    feats = {c: dbutil.coerce_feature(c, result.get(c)) for c in dbutil.FEATURE_COLUMNS}
                    if feats.get("bpm") is None and feats.get("energy") is None:
                        continue  # nothing usable came back
                    feats["feature_source"] = feats.get("feature_source") or "freqblog"
                    dbutil.update_track_features(cur, track["id"], feats)
                    written += 1
            conn.commit()
            print(f"  Written so far: {written}")

    print("\nFinished.")
    print(f"Tracks updated with features: {written}")


if __name__ == "__main__":
    main()
