#!/usr/bin/env python3
"""Add MusicBrainz associated-country metadata for every credited artist.

Uses a persistent local cache and respects MusicBrainz's request rate limit.
Set CONTACT_EMAIL in .env to a real contact address before running.
"""

import csv
import json
import os
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import pycountry
import requests
from dotenv import load_dotenv

load_dotenv()

INPUT_DEFAULT = Path("spotify_exports/merged_playlists.csv")
CACHE_FILE = Path("musicbrainz_artist_cache.json")
API_URL = "https://musicbrainz.org/ws/2/artist"
CONTACT_EMAIL = os.getenv("CONTACT_EMAIL", "").strip()
MIN_REQUEST_INTERVAL = 1.1
OUTPUT_COLUMNS = [
    "artist_countries",
    "artist_country_codes",
    "artist_country_details",
    "artist_country_status",
    "greek_artist",
]


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value).casefold())
    return "".join(
        char for char in value
        if not unicodedata.combining(char) and char.isalnum()
    )


def unique_names(names: list[str]) -> list[str]:
    result = []
    seen = set()
    for name in names:
        name = str(name).strip()
        key = normalize_name(name)
        if name and key and key not in seen:
            seen.add(key)
            result.append(name)
    return result


def parse_artist_names(row: dict) -> list[str]:
    raw_json = (row.get("artist_names_json") or "").strip()
    if raw_json:
        try:
            names = json.loads(raw_json)
            if isinstance(names, list):
                return unique_names([str(name) for name in names if str(name).strip()])
        except json.JSONDecodeError:
            pass

    # Fallback for older CSVs. This cannot reliably distinguish an artist
    # whose own name contains ', ' from two separate artist names.
    artists = (row.get("artists") or "").strip()
    if artists:
        return unique_names([part.strip() for part in artists.split(", ") if part.strip()])

    artist = (row.get("artist") or "").strip()
    return unique_names([artist] if artist else [])


def load_cache() -> dict:
    if not CACHE_FILE.exists():
        return {}
    try:
        with CACHE_FILE.open("r", encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        print("Warning: could not read cache; starting with an empty cache.")
        return {}


def save_cache(cache: dict) -> None:
    temp_file = CACHE_FILE.with_suffix(".tmp")
    with temp_file.open("w", encoding="utf-8") as file:
        json.dump(cache, file, ensure_ascii=False, indent=2)
    temp_file.replace(CACHE_FILE)


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
    if country:
        return code, country.name

    # Preserve uncommon/older codes rather than discarding the value.
    return code, code


def standard_result(status: str, artist: dict | None = None, candidates=None, similarity=None) -> dict:
    artist = artist or {}
    code, country_name = country_from_artist(artist)
    if not code and status in {"exact", "fuzzy"}:
        status += "_no_country"

    return {
        "status": status,
        "matched_artist": artist.get("name", ""),
        "musicbrainz_id": artist.get("id", ""),
        "country_code": code,
        "country_name": country_name,
        "score": artist.get("score", ""),
        "similarity": round(similarity, 3) if similarity is not None else "",
        "candidates": candidates or [],
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
        # MusicBrainz uses Lucene syntax; escape common query-special characters.
        special_chars = set(r'+-!(){}[]^"~*?:\\/&|')
        escaped = "".join(("\\" + char) if char in special_chars else char for char in name)
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
    exact = [candidate for candidate in candidates if normalize_name(candidate.get("name", "")) == target]

    if len(exact) == 1:
        return standard_result("exact", exact[0])

    if len(exact) > 1:
        countries = [country_from_artist(candidate) for candidate in exact]
        codes = {code for code, _ in countries}
        if len(codes) == 1 and "" not in codes:
            best = max(exact, key=lambda candidate: float(candidate.get("score", 0) or 0))
            result = standard_result("ambiguous_same_country", best)
            result["candidates"] = [candidate.get("name", "") for candidate in exact]
            return result
        return standard_result("ambiguous", candidates=[candidate.get("name", "") for candidate in exact])

    ranked = []
    for candidate in candidates:
        candidate_name = candidate.get("name", "")
        similarity = SequenceMatcher(None, target, normalize_name(candidate_name)).ratio()
        try:
            score = float(candidate.get("score", 0) or 0)
        except (TypeError, ValueError):
            score = 0.0
        ranked.append((similarity, score, candidate))

    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    if not ranked or ranked[0][0] < 0.94:
        return standard_result("not_found", candidates=[candidate.get("name", "") for _, _, candidate in ranked[:5]])

    best_similarity = ranked[0][0]
    close = [item for item in ranked if best_similarity - item[0] <= 0.02]
    close_countries = {
        country_from_artist(candidate)[0]
        for _, _, candidate in close
        if country_from_artist(candidate)[0]
    }
    if len(close_countries) > 1:
        return standard_result(
            "ambiguous",
            candidates=[candidate.get("name", "") for _, _, candidate in close],
            similarity=best_similarity,
        )

    return standard_result("fuzzy", ranked[0][2], similarity=best_similarity)


def get_artist_country(name: str, client: MusicBrainzClient, cache: dict) -> dict:
    key = normalize_name(name)
    if key in cache:
        return cache[key]

    result = match_artist(name, client.search_artist(name))
    result["query_name"] = name
    cache[key] = result
    save_cache(cache)
    return result


def enrich_row(row: dict, client: MusicBrainzClient, cache: dict) -> dict:
    names = parse_artist_names(row)
    artist_results = [(name, get_artist_country(name, client, cache)) for name in names]

    country_map = {}
    details = []
    result_statuses = []

    for name, result in artist_results:
        code = result.get("country_code", "")
        country = result.get("country_name", "")
        status = result.get("status", "unknown")
        result_statuses.append(status)
        if code:
            country_map[code] = country
            details.append(f"{name}={country} [{status}]")
        else:
            details.append(f"{name}=Unknown [{status}]")

    country_codes = sorted(country_map)
    countries = sorted(set(country_map.values()), key=str.casefold)
    all_known = bool(artist_results) and all(
        result.get("country_code") for _, result in artist_results
    )

    if not names:
        country_status = "unknown"
    elif all_known:
        country_status = "complete"
    elif any("ambiguous" in status for status in result_statuses):
        country_status = "ambiguous"
    elif countries:
        country_status = "partial"
    else:
        country_status = "unknown"

    if "GR" in country_codes:
        greek_artist = "Yes"
    elif all_known:
        greek_artist = "No"
    else:
        greek_artist = "Unknown"

    row["artist_countries"] = "; ".join(countries)
    row["artist_country_codes"] = "; ".join(country_codes)
    row["artist_country_details"] = "; ".join(details)
    row["artist_country_status"] = country_status
    row["greek_artist"] = greek_artist
    return row


def main() -> None:
    input_path = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else INPUT_DEFAULT
    if not input_path.is_file():
        raise SystemExit(f"Input CSV not found: {input_path}")

    with input_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            raise SystemExit("Input CSV has no header.")
        fieldnames = list(reader.fieldnames)
        rows = list(reader)

    if not any(field in fieldnames for field in ("artist_names_json", "artists", "artist")):
        raise SystemExit("CSV needs 'artist_names_json', 'artists', or 'artist'.")

    if not CONTACT_EMAIL or CONTACT_EMAIL == "your-email@example.com":
        raise SystemExit("Set CONTACT_EMAIL in .env to a real contact email for MusicBrainz.")

    for column in OUTPUT_COLUMNS:
        if column not in fieldnames:
            fieldnames.append(column)

    cache = load_cache()
    client = MusicBrainzClient()
    unique_artists = {
        normalize_name(name)
        for row in rows
        for name in parse_artist_names(row)
        if normalize_name(name)
    }

    print(f"Input: {input_path}")
    print(f"Tracks: {len(rows)}")
    print(f"Distinct artist names: {len(unique_artists)}")
    print(f"Cached lookups: {len(cache)}")

    for index, row in enumerate(rows, start=1):
        try:
            enrich_row(row, client, cache)
        except (requests.RequestException, RuntimeError) as exc:
            save_cache(cache)
            raise SystemExit(
                f"Lookup failed at track row {index}: {exc}\n"
                "The input CSV is unchanged. Run the script again to continue using the cache."
            ) from exc

        if index % 25 == 0 or index == len(rows):
            print(f"Processed {index}/{len(rows)} tracks")

    output_path = input_path.with_name(f"{input_path.stem}_countries.csv")
    with output_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    print("\nCompleted.")
    print(f"Output: {output_path.resolve()}")
    print(f"Cache: {CACHE_FILE.resolve()}")


if __name__ == "__main__":
    main()
