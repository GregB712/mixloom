"""Server-side Spotify OAuth. Writes the same token caches the scripts use."""

import os

from spotipy.oauth2 import SpotifyOAuth

from config import (
    PLAYER_SCOPES,
    PLAYER_TOKEN_CACHE,
    READ_SCOPES,
    READ_TOKEN_CACHE,
    WRITE_SCOPES,
    WRITE_TOKEN_CACHE,
)

_SCOPE_CONFIG = {
    "read": (READ_SCOPES, READ_TOKEN_CACHE),
    "write": (WRITE_SCOPES, WRITE_TOKEN_CACHE),
    "player": (PLAYER_SCOPES, PLAYER_TOKEN_CACHE),
}


def _oauth(scope_key: str) -> SpotifyOAuth:
    scope, cache_path = _SCOPE_CONFIG[scope_key]
    return SpotifyOAuth(
        client_id=os.environ["SPOTIPY_CLIENT_ID"],
        client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
        redirect_uri=os.environ["SPOTIPY_REDIRECT_URI"],
        scope=scope,
        cache_path=str(cache_path),
        open_browser=False,
    )


def authorize_url(scope_key: str) -> str:
    # `state` carries the scope so the single callback knows which cache to write.
    return _oauth(scope_key).get_authorize_url(state=scope_key)


def exchange_code(scope_key: str, code: str) -> None:
    # Writes token_info to the cache file in spotipy's own format.
    _oauth(scope_key).get_access_token(code, as_dict=False, check_cache=False)


def auth_status() -> dict[str, bool]:
    """True when a usable (refreshable) token is cached for each scope."""
    status = {}
    for key in ("read", "write", "player"):
        try:
            token = _oauth(key).get_cached_token()
            status[key] = bool(token and token.get("refresh_token"))
        except Exception:
            status[key] = False
    return status


def access_token(scope_key: str) -> str | None:
    """A currently-valid access token for the scope, or None if not authorized.
    get_cached_token() refreshes the token automatically when it has expired."""
    try:
        token = _oauth(scope_key).get_cached_token()
    except Exception:
        return None
    return token.get("access_token") if token else None
