"""Shared paths and settings for the backend. Reads the same .env as the scripts."""

import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

# Project root = two levels up from this file (web/backend/ -> project root).
ROOT = Path(__file__).resolve().parent.parent.parent

load_dotenv(ROOT / ".env")

# Token caches the existing scripts read/write. We write the same files so the
# scripts can run headless (no browser popup) once the user has authorized here.
READ_TOKEN_CACHE = ROOT / ".spotify_token_cache"
WRITE_TOKEN_CACHE = ROOT / ".spotify_playlist_create_token_cache"
# Separate cache for the in-browser Web Playback SDK, so authorizing playback
# doesn't invalidate the read/write tokens the scripts rely on.
PLAYER_TOKEN_CACHE = ROOT / ".spotify_player_token_cache"

READ_SCOPES = "playlist-read-private playlist-read-collaborative"
WRITE_SCOPES = "playlist-modify-private"
# streaming + the identity scopes the Web Playback SDK requires, plus the
# playback-state scopes needed to start/transfer playback to the browser device.
PLAYER_SCOPES = (
    "streaming user-read-email user-read-private "
    "user-read-playback-state user-modify-playback-state"
)

# CLI scripts (in scripts/), invoked as `python -u <script> <args>`.
SCRIPTS = {
    "export": "scripts/spotify_playlist_export.py",
    "enrich-countries": "scripts/enrich_artist_countries.py",
    "enrich-features": "scripts/enrich_spotify_csv.py",
    "analyze-local": "scripts/analyze_local_audio.py",
    "create-playlist": "scripts/create_spotify_playlist.py",
}

# Derive the backend bind host/port and the OAuth callback path from the
# registered redirect URI, so the user's existing Spotify app settings work.
REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
_parsed = urlparse(REDIRECT_URI)
BACKEND_HOST = _parsed.hostname or "127.0.0.1"
BACKEND_PORT = _parsed.port or 8888
CALLBACK_PATH = _parsed.path or "/callback"

# Where the backend sends the browser back after the OAuth callback.
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# Postgres metadata database (matches db/docker-compose.yml).
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://spotify:spotify@localhost:5432/spotify_meta"
)


def env_flags() -> dict[str, bool]:
    """Which .env keys are set (booleans only, never the values)."""
    contact = (os.getenv("CONTACT_EMAIL") or "").strip()
    return {
        "spotify": bool(
            os.getenv("SPOTIPY_CLIENT_ID")
            and os.getenv("SPOTIPY_CLIENT_SECRET")
            and os.getenv("SPOTIPY_REDIRECT_URI")
        ),
        "freqblog": bool((os.getenv("FREQBLOG_API_KEY") or "").strip()),
        "contactEmail": bool(contact) and contact != "your-email@example.com",
    }
