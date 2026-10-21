#!/usr/bin/env python3
"""Resolve each artist's associated country via MusicBrainz and store it on the
`artists` table.

Operates on the Postgres DB. Optionally restrict to artists credited on tracks
in one or more playlists; with no --playlists it covers every artist missing a
country_status. Uses a persistent local cache and respects MusicBrainz's rate
limit. Set CONTACT_EMAIL in .env to a real address first.

Usage:
    python enrich_artist_countries.py [--playlists 1,2,3] [--all] [--database-url URL]
"""

import argparse
import json
import os
import time
import unicodedata
from difflib import SequenceMatcher

import pycountry
import requests
from dotenv import load_dotenv

import dbutil
from dbutil import ROOT

load_dotenv(ROOT / ".env")

CACHE_FILE = ROOT / "musicbrainz_artist_cache.json"
API_URL = "https://musicbrainz.org/ws/2/artist"
CONTACT_EMAIL = os.getenv("CONTACT_EMAIL", "").strip()
MIN_REQUEST_INTERVAL = 1.1


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value).casefold())
    return "".join(c for c in value if not unicodedata.combining(c) and c.isalnum())


def load_cache() -> dict:
    if not CACHE_FILE.exists():
        return {}
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        print("Warning: could not read cache; starting empty.")
        return {}


def save_cache(cache: dict) -> None:
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CACHE_FILE)


def country_from_artist(artist: dict) -> tuple[str, str]:
    code = str(artist.get("country") or "").strip().upper()
    if not code:
        area = artist.get("area") or {}
        codes = area.get("iso-3166-1-codes") or area.get("iso_3166_1_codes") or []
        if len(codes) == 1:
            code = str(codes[0]).strip().upper()
    if not code:
        return "", ""
    country = pycountry.countries.get(alpha_2=code)
    return (code, country.name) if country else (code, code)


def standard_result(status: str, artist: dict | None = None, candidates=None, similarity=None) -> dict:
    artist = artist or {}
    code, country_name = country_from_artist(artist)
    if not code and status in {"exact", "fuzzy"}:
        status += "_no_country"
    return {
        "status": status, "country_code": code, "country_name": country_name,
        "musicbrainz_id": artist.get("id", ""), "candidates": candidates or [],
    }


class MusicBrainzClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": f"SpotifyArtistCountryEnricher/1.0 (contact: {CONTACT_EMAIL})",
            "Accept": "application/json",
        })
        self.last_request = 0.0

    def search_artist(self, name: str) -> list[dict]:
        special = set(r'+-!(){}[]^"~*?:\\/&|')
        escaped = "".join(("\\" + c) if c in special else c for c in name)
        params = {"query": f'artist:"{escaped}"', "fmt": "json", "limit": 10}
        for attempt in range(5):
            wait = MIN_REQUEST_INTERVAL - (time.monotonic() - self.last_request)
            if wait > 0:
                time.sleep(wait)
            response = self.session.get(API_URL, params=params, timeout=30)
            self.last_request = time.monotonic()
            if response.status_code in (429, 503):
                try:
                    retry_after = float(response.headers.get("Retry-After", ""))
                except ValueError:
                    retry_after = 0
                time.sleep(max(retry_after, 2 ** attempt))
                continue
            response.raise_for_status()
            return response.json().get("artists", [])
        raise RuntimeError(f"MusicBrainz stayed unavailable for artist: {name}")


def match_artist(name: str, candidates: list[dict]) -> dict:
    target = normalize_name(name)
    exact = [c for c in candidates if normalize_name(c.get("name", "")) == target]
    if len(exact) == 1:
        return standard_result("exact", exact[0])
    if len(exact) > 1:
        codes = {country_from_artist(c)[0] for c in exact}
        if len(codes) == 1 and "" not in codes:
            best = max(exact, key=lambda c: float(c.get("score", 0) or 0))
            return standard_result("ambiguous_same_country", best)
        return standard_result("ambiguous", candidates=[c.get("name", "") for c in exact])

    ranked = []
    for c in candidates:
        similarity = SequenceMatcher(None, target, normalize_name(c.get("name", ""))).ratio()
        try:
            score = float(c.get("score", 0) or 0)
        except (TypeError, ValueError):
            score = 0.0
        ranked.append((similarity, score, c))
    ranked.sort(key=lambda i: (i[0], i[1]), reverse=True)
    if not ranked or ranked[0][0] < 0.94:
        return standard_result("not_found", candidates=[c.get("name", "") for _, _, c in ranked[:5]])
    best_similarity = ranked[0][0]
    close = [i for i in ranked if best_similarity - i[0] <= 0.02]
    close_countries = {country_from_artist(c)[0] for _, _, c in close if country_from_artist(c)[0]}
    if len(close_countries) > 1:
        return standard_result("ambiguous", candidates=[c.get("name", "") for _, _, c in close], similarity=best_similarity)
    return standard_result("fuzzy", ranked[0][2], similarity=best_similarity)


def get_artist_country(name: str, client: MusicBrainzClient, cache: dict) -> dict:
    key = normalize_name(name)
    if key in cache:
        return cache[key]
    result = match_artist(name, client.search_artist(name))
    cache[key] = result
    save_cache(cache)
    return result


def select_artists(cur, playlist_ids: list[int], include_all: bool) -> list[tuple[int, str]]:
    # "Missing metadata" = no resolved country yet (country_code NULL). This
    # retries artists MusicBrainz couldn't place before (results are cached, so
    # re-runs are cheap) and skips any artist that already has a country.
    where = [] if include_all else ["a.country_code IS NULL"]
    params: list = []
    if playlist_ids:
        where.append(
            "EXISTS (SELECT 1 FROM track_artists ta JOIN playlist_tracks pt "
            "ON pt.track_id = ta.track_id WHERE ta.artist_id = a.id "
            "AND pt.playlist_id = ANY(%s))"
        )
        params.append(playlist_ids)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    cur.execute(f"SELECT a.id, a.name FROM artists a{clause} ORDER BY a.id", params)
    return [(r[0], r[1]) for r in cur.fetchall()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich artist countries via MusicBrainz into the DB.")
    parser.add_argument("--playlists", default="", help="comma-separated playlist ids (default: all)")
    parser.add_argument("--all", action="store_true", help="re-resolve even artists that already have a status")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    if not CONTACT_EMAIL or CONTACT_EMAIL == "your-email@example.com":
        raise SystemExit("Set CONTACT_EMAIL in .env to a real contact email for MusicBrainz.")
    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    playlist_ids = [int(p) for p in args.playlists.split(",") if p.strip()]

    try:
        conn = dbutil.connect(args.database_url)
    except Exception as exc:
        raise SystemExit(f"Could not connect to the database: {exc}")

    cache = load_cache()
    client = MusicBrainzClient()
    with conn:
        with conn.cursor() as cur:
            artists = select_artists(cur, playlist_ids, args.all)
            in_scope = len(select_artists(cur, playlist_ids, True))
        scope = f"playlists {playlist_ids}" if playlist_ids else "all playlists"
        print(f"Scope: {scope}")
        if args.all:
            print(f"Artists in scope: {in_scope} | re-resolving all (--all)  (cached: {len(cache)})")
        else:
            print(f"Artists in scope: {in_scope} | already resolved: {in_scope - len(artists)} "
                  f"| to resolve (missing): {len(artists)}  (cached: {len(cache)})")
        if not artists:
            print("Nothing to do — every artist in scope already has a country.")
            return

        updated = 0
        for index, (artist_id, name) in enumerate(artists, 1):
            try:
                result = get_artist_country(name, client, cache)
            except (requests.RequestException, RuntimeError) as exc:
                conn.commit()
                raise SystemExit(f"Lookup failed for '{name}': {exc}\nProgress committed; re-run to continue.")
            with conn.cursor() as cur:
                dbutil.update_artist_country(
                    cur, artist_id,
                    result.get("country_code") or None,
                    result.get("country_name") or None,
                    result.get("status") or "unknown",
                )
            updated += 1
            if index % 25 == 0 or index == len(artists):
                conn.commit()
                print(f"Processed {index}/{len(artists)} artists")
        conn.commit()

    print("\nCompleted.")
    print(f"Artists updated: {updated}")
    print(f"Cache: {CACHE_FILE.resolve()}")


if __name__ == "__main__":
    main()
