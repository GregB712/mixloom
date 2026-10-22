#!/usr/bin/env python3
"""Fill audio-feature / tag metadata for feature-less tracks in the database,
using a pluggable enrichment provider (FreqBlog by default; see
feature_providers.py to add more).

Operates on the Postgres DB (not files). Optionally restrict to one or more
playlists; with no --playlists it covers every feature-less track.

Usage:
    python enrich_spotify_csv.py [--provider freqblog|lastfm] [--playlists 1,2,3]
                                 [--all] [--database-url URL]
"""

import argparse

import requests
from dotenv import load_dotenv

import dbutil
from dbutil import ROOT
from feature_providers import PROVIDERS, get_provider

load_dotenv(ROOT / ".env")

COMMIT_EVERY = 200  # flush feature writes periodically


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich audio features/tags into the DB via a provider.")
    parser.add_argument("--provider", default="freqblog", choices=list(PROVIDERS),
                        help="enrichment source (default: freqblog)")
    parser.add_argument("--playlists", default="", help="comma-separated playlist ids (default: all)")
    parser.add_argument("--all", action="store_true", help="re-enrich even tracks that already have features")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    provider = get_provider(args.provider)
    ok, reason = provider.available()
    if not ok:
        raise SystemExit(reason)

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
        print(f"Provider: {provider.name}")
        print(f"Scope: {scope}")
        if args.all:
            print(f"Tracks in scope: {in_scope} | re-enriching all (--all)")
        else:
            print(f"Tracks in scope: {in_scope} | already have features: {in_scope - len(tracks)} "
                  f"| to enrich (missing): {len(tracks)}")
        if not tracks:
            print("Nothing to do — every track in scope already has features.")
            return

        written = 0
        try:
            cur = conn.cursor()
            for track_id, feats in provider.enrich(tracks, print):
                dbutil.update_track_features(cur, track_id, feats)
                written += 1
                if written % COMMIT_EVERY == 0:
                    conn.commit()
                    print(f"  Written so far: {written}")
            cur.close()
            conn.commit()
        except (requests.RequestException, RuntimeError) as exc:
            conn.rollback()
            raise SystemExit(f"Enrichment failed: {exc}\nPartial progress up to the last commit was kept.")

    print("\nFinished.")
    print(f"Tracks updated: {written}")


if __name__ == "__main__":
    main()
