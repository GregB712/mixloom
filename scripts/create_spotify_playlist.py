#!/usr/bin/env python3
"""Create a new private Spotify playlist from a playlist stored in the database.

Reads the track URIs of a DB playlist (in order) and adds them to a freshly
created private playlist. Requires the SPOTIPY_* variables in .env.

Usage:
    python create_spotify_playlist.py <playlist_db_id> [new playlist name]
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

# Use a separate token cache so Spotify asks for the new write permission.
TOKEN_CACHE = str(ROOT / ".spotify_playlist_create_token_cache")
SCOPE = "playlist-modify-private"
BATCH_SIZE = 100


def read_playlist(playlist_id: int) -> tuple[str, list[str]]:
    """Return (playlist name, ordered track URIs) for a DB playlist."""
    with dbutil.connect() as conn:
        row = conn.execute("SELECT name FROM playlists WHERE id = %s", (playlist_id,)).fetchone()
        if not row:
            raise SystemExit(f"Playlist id {playlist_id} not found in the database.")
        name = row[0]
        uris = [
            r[0] for r in conn.execute(
                """SELECT t.spotify_uri FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                   WHERE pt.playlist_id = %s AND t.spotify_uri LIKE 'spotify:track:%%'
                   ORDER BY pt.position""",
                (playlist_id,),
            ).fetchall()
        ]
    if not uris:
        raise SystemExit("That playlist has no Spotify track URIs to add.")
    return name, uris


def main():
    required = ["SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit("Missing .env variables: " + ", ".join(missing))
    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    if len(sys.argv) >= 2:
        try:
            playlist_id = int(sys.argv[1])
        except ValueError:
            raise SystemExit("First argument must be the playlist's database id.")
    else:
        playlist_id = int(input("Playlist database id: ").strip())

    source_name, uris = read_playlist(playlist_id)
    playlist_name = " ".join(sys.argv[2:]).strip() if len(sys.argv) >= 3 else source_name
    if not playlist_name:
        raise SystemExit("Playlist name cannot be empty.")

    print(f"\nSource playlist (db id {playlist_id}): {source_name}")
    print(f"Tracks to add: {len(uris)}")
    print(f"New playlist name: {playlist_name}")
    print("Visibility: Private")

    confirmation = input("\nCreate this playlist on Spotify? [y/N]: ").strip().lower()
    if confirmation != "y":
        print("Cancelled. No playlist was created.")
        return

    auth_manager = SpotifyOAuth(
        client_id=os.environ["SPOTIPY_CLIENT_ID"],
        client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
        redirect_uri=os.environ["SPOTIPY_REDIRECT_URI"],
        scope=SCOPE,
        cache_path=TOKEN_CACHE,
        open_browser=True,
    )
    spotify = spotipy.Spotify(auth_manager=auth_manager)

    playlist = None
    added = 0
    try:
        playlist = spotify.current_user_playlist_create(
            name=playlist_name, public=False,
            description="Created from the metadata database.",
        )
        playlist_id_sp = playlist["id"]
        for start in range(0, len(uris), BATCH_SIZE):
            batch = uris[start:start + BATCH_SIZE]
            spotify.playlist_add_items(playlist_id_sp, batch)
            added += len(batch)
            print(f"Added {added}/{len(uris)} tracks")

        url = (playlist.get("external_urls") or {}).get("spotify", "")
        print("\nPlaylist created successfully.")
        print(f"Name: {playlist_name}")
        print(f"Tracks added: {added}")
        print(f"Spotify URL: {url}")
    except SpotifyException as exc:
        print(f"\nSpotify API error: HTTP {exc.http_status} - {exc.msg}")
        if playlist and added < len(uris):
            print(f"Playlist may be incomplete: {added} of {len(uris)} tracks added.")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
