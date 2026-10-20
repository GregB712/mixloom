#!/usr/bin/env python3
"""Export selected Spotify playlists to individual CSVs and a merged CSV.

Without arguments, lists the current user's playlists and prompts for a selection.
With arguments, accepts one or more comma-separated playlist IDs.
"""

import csv
import json
import os
import re
import sys
from pathlib import Path

import spotipy
from dotenv import load_dotenv
from spotipy.exceptions import SpotifyException
from spotipy.oauth2 import SpotifyOAuth

load_dotenv()

OUTPUT_DIR = Path("spotify_exports")
TOKEN_CACHE = ".spotify_token_cache"
SCOPES = "playlist-read-private playlist-read-collaborative"

CSV_COLUMNS = [
    "position",
    "title",
    "artists",
    "artist_names_json",
    "album",
    "duration_ms",
    "isrc",
    "spotify_url",
    "spotify_uri",
    "source_playlists",
]


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return (name[:100] or "playlist")


def write_csv(path: Path, tracks: list[dict], renumber: bool = False) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for index, track in enumerate(tracks, start=1):
            row = {column: track.get(column, "") for column in CSV_COLUMNS}
            if renumber:
                row["position"] = index
            row["source_playlists"] = "; ".join(
                sorted(track.get("_source_labels", set()), key=str.casefold)
            )
            writer.writerow(row)


def get_user_playlists(spotify: spotipy.Spotify) -> list[dict]:
    playlists = []
    page = spotify.current_user_playlists(limit=50)
    while page:
        playlists.extend(page.get("items", []))
        page = spotify.next(page) if page.get("next") else None
    return playlists


def choose_playlists(playlists: list[dict]) -> list[dict]:
    if not playlists:
        raise SystemExit("No playlists were found in your account.")

    print("\nYour Spotify playlists:\n")
    for number, playlist in enumerate(playlists, start=1):
        summary = playlist.get("items") or playlist.get("tracks") or {}
        total = summary.get("total", "?") if isinstance(summary, dict) else "?"
        print(f"{number:>3}. {playlist.get('name', 'Untitled')} ({total} tracks)")

    print("\nEnter playlist numbers separated by commas, e.g. 1,3,5.")
    print("Enter 'all' for every playlist, or 'q' to quit.")
    while True:
        answer = input("Your selection: ").strip()
        if answer.lower() in {"q", "quit"}:
            raise SystemExit("Cancelled.")
        if answer.lower() == "all":
            return playlists
        try:
            numbers = [int(part.strip()) for part in answer.split(",") if part.strip()]
            if not numbers:
                raise ValueError
            if any(number < 1 or number > len(playlists) for number in numbers):
                print(f"Enter numbers between 1 and {len(playlists)}.")
                continue
            numbers = list(dict.fromkeys(numbers))
            return [playlists[number - 1] for number in numbers]
        except ValueError:
            print("Invalid selection. Example: 1,3,5")


def get_playlist_tracks(spotify: spotipy.Spotify, playlist_id: str) -> tuple[str, list[dict]]:
    playlist = spotify.playlist(playlist_id, fields="id,name")
    playlist_name = playlist.get("name") or playlist_id
    source_label = f"{playlist_name} [{playlist_id}]"
    tracks = []

    page = spotify.playlist_items(
        playlist_id,
        limit=50,
        additional_types=("track",),
    )
    while page:
        for entry in page.get("items", []):
            track = entry.get("item") or entry.get("track")
            if not track or track.get("type") not in (None, "track"):
                continue

            artist_names = [
                str(artist.get("name", "")).strip()
                for artist in track.get("artists", [])
                if str(artist.get("name", "")).strip()
            ]
            album = track.get("album") or {}
            external_urls = track.get("external_urls") or {}
            external_ids = track.get("external_ids") or {}

            tracks.append({
                "position": len(tracks) + 1,
                "title": track.get("name") or "",
                "artists": ", ".join(artist_names),
                "artist_names_json": json.dumps(artist_names, ensure_ascii=False),
                "album": album.get("name") or "",
                "duration_ms": track.get("duration_ms") or "",
                "isrc": external_ids.get("isrc") or "",
                "spotify_url": external_urls.get("spotify") or "",
                "spotify_uri": track.get("uri") or "",
                "_source_labels": {source_label},
            })

        page = spotify.next(page) if page.get("next") else None

    return playlist_name, tracks


def deduplicate_tracks(tracks: list[dict]) -> list[dict]:
    unique = {}
    for track in tracks:
        uri = (track.get("spotify_uri") or "").strip()
        if uri:
            key = ("uri", uri.casefold())
        else:
            title = (track.get("title") or "").strip().casefold()
            artists = (track.get("artists") or "").strip().casefold()
            album = (track.get("album") or "").strip().casefold()
            duration = str(track.get("duration_ms") or "")
            if title or artists:
                key = ("metadata", title, artists, album, duration)
            else:
                source = "|".join(sorted(track.get("_source_labels", set())))
                key = ("unknown", source, str(track.get("position", "")))

        if key not in unique:
            unique[key] = dict(track)
            unique[key]["_source_labels"] = set(track.get("_source_labels", set()))
        else:
            existing = unique[key]
            existing["_source_labels"].update(track.get("_source_labels", set()))
            for field in (
                "title", "artists", "artist_names_json", "album",
                "duration_ms", "isrc", "spotify_url", "spotify_uri",
            ):
                if not existing.get(field) and track.get(field):
                    existing[field] = track[field]

    result = list(unique.values())
    result.sort(key=lambda track: (
        (track.get("title") or "").casefold(),
        (track.get("artists") or "").casefold(),
    ))
    return result


def main() -> None:
    required = ["SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit("Missing .env variables: " + ", ".join(missing))

    auth = SpotifyOAuth(
        client_id=os.environ["SPOTIPY_CLIENT_ID"],
        client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
        redirect_uri=os.environ["SPOTIPY_REDIRECT_URI"],
        scope=SCOPES,
        cache_path=TOKEN_CACHE,
        open_browser=True,
    )
    spotify = spotipy.Spotify(auth_manager=auth)

    if len(sys.argv) > 1:
        raw_ids = ",".join(sys.argv[1:])
        playlist_ids = list(dict.fromkeys(
            part.strip() for part in raw_ids.split(",") if part.strip()
        ))
        targets = [{"id": playlist_id, "name": None} for playlist_id in playlist_ids]
    else:
        try:
            targets = [
                {"id": playlist["id"], "name": playlist.get("name")}
                for playlist in choose_playlists(get_user_playlists(spotify))
            ]
        except SpotifyException as exc:
            raise SystemExit(
                f"Could not retrieve playlists: HTTP {exc.http_status} - {exc.msg}"
            ) from exc

    if not targets:
        raise SystemExit("No playlists selected.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_tracks = []
    successful = 0

    for target in targets:
        playlist_id = target["id"]
        print(f"\nProcessing: {target.get('name') or playlist_id}")
        try:
            playlist_name, tracks = get_playlist_tracks(spotify, playlist_id)
            short_id = re.sub(r"[^A-Za-z0-9_-]", "", playlist_id)[:8] or "playlist"
            output_path = OUTPUT_DIR / f"{safe_filename(playlist_name)}__{short_id}.csv"
            write_csv(output_path, tracks)
            all_tracks.extend(tracks)
            successful += 1
            print(f"  Tracks: {len(tracks)}")
            print(f"  Saved: {output_path}")
        except SpotifyException as exc:
            print(f"  Spotify API error: HTTP {exc.http_status} - {exc.msg}")
        except Exception as exc:
            print(f"  Failed to process playlist: {exc}")

    if successful == 0:
        raise SystemExit("No playlists were retrieved successfully.")

    merged = deduplicate_tracks(all_tracks)
    merged_path = OUTPUT_DIR / "merged_playlists.csv"
    write_csv(merged_path, merged, renumber=True)

    print("\nCompleted.")
    print(f"Playlists processed: {successful}")
    print(f"Tracks before deduplication: {len(all_tracks)}")
    print(f"Unique tracks: {len(merged)}")
    print(f"Merged CSV: {merged_path.resolve()}")


if __name__ == "__main__":
    main()
