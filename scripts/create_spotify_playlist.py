#!/usr/bin/env python3
"""Create or update a private Spotify playlist from a playlist in the database.

Reads the track URIs of a DB playlist (in order). By default it creates a fresh
private playlist and records its Spotify id on the DB row. With --update, if the
DB row already has a recorded Spotify playlist id, it replaces that playlist's
tracks in place (no new playlist), falling back to creating one if the stored
playlist is gone. Requires the SPOTIPY_* variables in .env.

Usage:
    python create_spotify_playlist.py <playlist_db_id> [new playlist name] [--update]
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


def read_playlist(playlist_id: int) -> tuple[str, list[str], str | None]:
    """Return (name, ordered track URIs, recorded Spotify playlist id) for a DB playlist."""
    with dbutil.connect() as conn:
        row = conn.execute(
            "SELECT name, spotify_playlist_id FROM playlists WHERE id = %s", (playlist_id,)
        ).fetchone()
        if not row:
            raise SystemExit(f"Playlist id {playlist_id} not found in the database.")
        name, spotify_playlist_id = row
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
    return name, uris, spotify_playlist_id


def store_spotify_id(playlist_id: int, spotify_playlist_id: str | None) -> None:
    with dbutil.connect() as conn:
        with conn.cursor() as cur:
            dbutil.set_playlist_spotify_id(cur, playlist_id, spotify_playlist_id)
        conn.commit()


def replace_tracks(spotify: spotipy.Spotify, sp_playlist_id: str, uris: list[str]) -> int:
    """Replace a playlist's items with `uris` (first 100 replace, rest appended)."""
    spotify.playlist_replace_items(sp_playlist_id, uris[:BATCH_SIZE])
    added = min(len(uris), BATCH_SIZE)
    for start in range(BATCH_SIZE, len(uris), BATCH_SIZE):
        batch = uris[start:start + BATCH_SIZE]
        spotify.playlist_add_items(sp_playlist_id, batch)
        added += len(batch)
    return added


def main():
    required = ["SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit("Missing .env variables: " + ", ".join(missing))
    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    args = [a for a in sys.argv[1:] if a != "--update"]
    update = "--update" in sys.argv[1:]

    if args:
        try:
            playlist_id = int(args[0])
        except ValueError:
            raise SystemExit("First argument must be the playlist's database id.")
    else:
        playlist_id = int(input("Playlist database id: ").strip())

    source_name, uris, existing_sp_id = read_playlist(playlist_id)
    playlist_name = " ".join(args[1:]).strip() if len(args) >= 2 else source_name
    if not playlist_name:
        raise SystemExit("Playlist name cannot be empty.")

    will_update = update and bool(existing_sp_id)
    print(f"\nSource playlist (db id {playlist_id}): {source_name}")
    print(f"Tracks to add: {len(uris)}")
    print(f"Playlist name: {playlist_name}")
    if will_update:
        print(f"Mode: update existing Spotify playlist ({existing_sp_id}) in place")
    else:
        print("Mode: create new private playlist")

    verb = "Update" if will_update else "Create"
    confirmation = input(f"\n{verb} this playlist on Spotify? [y/N]: ").strip().lower()
    if confirmation != "y":
        print("Cancelled. No changes were made on Spotify.")
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

    try:
        if will_update:
            try:
                added = replace_tracks(spotify, existing_sp_id, uris)
                url = f"https://open.spotify.com/playlist/{existing_sp_id}"
                print("\nPlaylist updated successfully.")
                print(f"Tracks now in playlist: {added}")
                print(f"Spotify URL: {url}")
                return
            except SpotifyException as exc:
                if exc.http_status == 404:
                    print("Stored Spotify playlist no longer exists; creating a new one.")
                    store_spotify_id(playlist_id, None)
                else:
                    raise

        playlist = spotify.current_user_playlist_create(
            name=playlist_name, public=False,
            description="Created from the metadata database.",
        )
        playlist_id_sp = playlist["id"]
        added = 0
        for start in range(0, len(uris), BATCH_SIZE):
            batch = uris[start:start + BATCH_SIZE]
            spotify.playlist_add_items(playlist_id_sp, batch)
            added += len(batch)
            print(f"Added {added}/{len(uris)} tracks")

        # Record the new Spotify id so a later push can update it in place.
        store_spotify_id(playlist_id, playlist_id_sp)
        url = (playlist.get("external_urls") or {}).get("spotify", "")
        print("\nPlaylist created successfully.")
        print(f"Name: {playlist_name}")
        print(f"Tracks added: {added}")
        print(f"Spotify URL: {url}")
    except SpotifyException as exc:
        print(f"\nSpotify API error: HTTP {exc.http_status} - {exc.msg}")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
