#!/usr/bin/env python3
"""Create a new private Spotify playlist from an exported playlist CSV.

Reads Spotify track URIs from the CSV and adds them to a freshly created
private playlist. Requires the SPOTIPY_* variables in .env.
"""

import csv
import os
import re
import sys
from pathlib import Path

import spotipy
from dotenv import load_dotenv
from spotipy.exceptions import SpotifyException
from spotipy.oauth2 import SpotifyOAuth

load_dotenv()

# Use a separate token cache so Spotify asks for the new write permission.
TOKEN_CACHE = ".spotify_playlist_create_token_cache"
SCOPE = "playlist-modify-private"

BATCH_SIZE = 100


def read_track_uris(csv_path):
    """Read Spotify track URIs from a playlist-export CSV."""
    tracks = []
    skipped = 0

    with csv_path.open(
        "r", newline="", encoding="utf-8-sig"
    ) as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames or (
            "spotify_uri" not in reader.fieldnames
            and "spotify_url" not in reader.fieldnames
        ):
            raise ValueError(
                "CSV must contain a spotify_uri or spotify_url column."
            )

        for row in reader:
            uri = (row.get("spotify_uri") or "").strip()

            # Fall back to the Spotify track URL if necessary.
            if not uri:
                url = (row.get("spotify_url") or "").strip()
                match = re.search(
                    r"open\.spotify\.com/track/([A-Za-z0-9]+)",
                    url,
                )
                if match:
                    uri = f"spotify:track:{match.group(1)}"

            if uri.startswith("spotify:track:"):
                tracks.append(uri)
            else:
                skipped += 1

    if not tracks:
        raise ValueError(
            "No valid Spotify track URIs were found in the CSV."
        )

    return tracks, skipped


def main():
    required = [
        "SPOTIPY_CLIENT_ID",
        "SPOTIPY_CLIENT_SECRET",
        "SPOTIPY_REDIRECT_URI",
    ]

    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit(
            "Missing .env variables: " + ", ".join(missing)
        )

    # Accept CSV path and playlist name as command-line arguments,
    # or prompt for them interactively.
    if len(sys.argv) >= 2:
        csv_path = Path(sys.argv[1]).expanduser()
    else:
        csv_path = Path(
            input("Path to CSV file: ").strip()
        ).expanduser()

    if not csv_path.is_file():
        raise SystemExit(f"CSV file not found: {csv_path}")

    if len(sys.argv) >= 3:
        playlist_name = " ".join(sys.argv[2:]).strip()
    else:
        playlist_name = input(
            "Name for the new Spotify playlist: "
        ).strip()

    if not playlist_name:
        raise SystemExit("Playlist name cannot be empty.")

    try:
        uris, skipped = read_track_uris(csv_path)
    except (OSError, ValueError, csv.Error) as exc:
        raise SystemExit(f"Could not read CSV: {exc}") from exc

    print(f"\nCSV: {csv_path}")
    print(f"Tracks to add: {len(uris)}")
    if skipped:
        print(f"Rows skipped (no valid Spotify track URI): {skipped}")

    print(f"Playlist name: {playlist_name}")
    print("Visibility: Private")

    confirmation = input(
        "\nCreate this playlist on Spotify? [y/N]: "
    ).strip().lower()

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

    spotify = spotipy.Spotify(
        auth_manager=auth_manager
    )

    playlist = None
    added = 0

    try:
        # Create a private playlist.
        playlist = spotify.current_user_playlist_create(
            name=playlist_name,
            public=False,
            description="Created from a CSV playlist export.",
        )

        playlist_id = playlist["id"]

        # Add tracks in batches of at most 100, preserving CSV order.
        for start in range(0, len(uris), BATCH_SIZE):
            batch = uris[start:start + BATCH_SIZE]

            spotify.playlist_add_items(
                playlist_id,
                batch,
            )

            added += len(batch)
            print(f"Added {added}/{len(uris)} tracks")

        url = (
            playlist.get("external_urls") or {}
        ).get("spotify", "")

        print("\nPlaylist created successfully.")
        print(f"Name: {playlist_name}")
        print(f"Tracks added: {added}")
        print(f"Spotify URL: {url}")

    except SpotifyException as exc:
        print(
            f"\nSpotify API error: HTTP {exc.http_status} - {exc.msg}"
        )

        if playlist and added < len(uris):
            url = (
                playlist.get("external_urls") or {}
            ).get("spotify", "")
            print(
                f"Playlist may be incomplete: {added} of "
                f"{len(uris)} tracks were added."
            )
            print(f"Playlist URL: {url}")

        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
