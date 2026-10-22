#!/usr/bin/env python3
"""Download selected Spotify playlists and save them to the Postgres database.

Playlists are kept distinct (no merge). Each playlist becomes a row in
`playlists`; its tracks are upserted into `tracks` (deduplicated by spotify_uri
across the whole library) and linked through `playlist_tracks`, preserving order.

Without arguments, lists the user's playlists and prompts for a selection.
With arguments, accepts one or more comma-separated playlist IDs.
"""

import os
import sys

import spotipy
from dotenv import load_dotenv
from spotipy.exceptions import SpotifyException
from spotipy.oauth2 import SpotifyOAuth

import dbutil
from dbutil import ROOT

load_dotenv(ROOT / ".env")

TOKEN_CACHE = str(ROOT / ".spotify_token_cache")
SCOPES = "playlist-read-private playlist-read-collaborative"


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
        summary = playlist.get("tracks") or {}
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
            if not numbers or any(n < 1 or n > len(playlists) for n in numbers):
                print(f"Enter numbers between 1 and {len(playlists)}.")
                continue
            return [playlists[n - 1] for n in dict.fromkeys(numbers)]
        except ValueError:
            print("Invalid selection. Example: 1,3,5")


def get_playlist_tracks(spotify: spotipy.Spotify, playlist_id: str) -> tuple[str, list[dict]]:
    playlist = spotify.playlist(playlist_id, fields="id,name")
    playlist_name = playlist.get("name") or playlist_id
    tracks = []

    page = spotify.playlist_items(playlist_id, limit=50, additional_types=("track",))
    while page:
        for entry in page.get("items", []):
            track = entry.get("item") or entry.get("track")
            if not track or track.get("type") not in (None, "track"):
                continue
            uri = track.get("uri") or ""
            if not uri:
                continue  # local/unavailable tracks have no uri to key on

            artist_names = [
                str(a.get("name", "")).strip()
                for a in track.get("artists", [])
                if str(a.get("name", "")).strip()
            ]
            album = track.get("album") or {}
            images = album.get("images") or []
            tracks.append({
                "spotify_uri": uri,
                "title": track.get("name") or "",
                "artists_text": ", ".join(artist_names),
                "artist_names": artist_names,
                "album": (album.get("name") or "") or None,
                # Spotify returns album images largest-first; keep the first URL.
                "album_art_url": (images[0].get("url") if images else None) or None,
                "duration_ms": track.get("duration_ms"),
                "isrc": (track.get("external_ids") or {}).get("isrc") or None,
                "spotify_url": (track.get("external_urls") or {}).get("spotify") or None,
            })
        page = spotify.next(page) if page.get("next") else None

    return playlist_name, tracks


def save_playlist(conn, playlist_id: str, playlist_name: str, tracks: list[dict]) -> None:
    """Write one playlist and its tracks to the DB in a single transaction."""
    with conn.cursor() as cur:
        pl_id = dbutil.upsert_playlist(cur, spotify_id=playlist_id, name=playlist_name)
        # Rebuild membership so a re-export reflects the playlist's current state.
        dbutil.clear_playlist(cur, pl_id)
        for position, track in enumerate(tracks):
            names = track.pop("artist_names", [])
            data = {k: v for k, v in track.items() if v is not None or k == "spotify_uri"}
            data["duration_ms"] = dbutil.to_int(data.get("duration_ms"))
            track_id = dbutil.upsert_track(cur, data)
            dbutil.set_track_artists(cur, track_id, names)
            dbutil.link_playlist_track(cur, pl_id, track_id, position)
    conn.commit()


def main() -> None:
    required = ["SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit("Missing .env variables: " + ", ".join(missing))

    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

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
        ids = list(dict.fromkeys(p.strip() for p in raw_ids.split(",") if p.strip()))
        targets = [{"id": pid, "name": None} for pid in ids]
    else:
        try:
            targets = [
                {"id": pl["id"], "name": pl.get("name")}
                for pl in choose_playlists(get_user_playlists(spotify))
            ]
        except SpotifyException as exc:
            raise SystemExit(f"Could not retrieve playlists: HTTP {exc.http_status} - {exc.msg}")

    if not targets:
        raise SystemExit("No playlists selected.")

    try:
        conn = dbutil.connect()
    except Exception as exc:
        raise SystemExit(
            f"Could not connect to the database: {exc}\n"
            "Start it with:  docker compose -f db/docker-compose.yml up -d"
        )

    successful = total_tracks = 0
    with conn:
        for target in targets:
            playlist_id = target["id"]
            print(f"\nProcessing: {target.get('name') or playlist_id}")
            try:
                name, tracks = get_playlist_tracks(spotify, playlist_id)
                save_playlist(conn, playlist_id, name, tracks)
                successful += 1
                total_tracks += len(tracks)
                print(f"  Saved '{name}': {len(tracks)} tracks -> database")
            except SpotifyException as exc:
                print(f"  Spotify API error: HTTP {exc.http_status} - {exc.msg}")
            except Exception as exc:
                conn.rollback()
                print(f"  Failed to process playlist: {exc}")

    if successful == 0:
        raise SystemExit("No playlists were saved.")

    print("\nCompleted.")
    print(f"Playlists saved: {successful}")
    print(f"Tracks written (incl. duplicates across playlists): {total_tracks}")


if __name__ == "__main__":
    main()
