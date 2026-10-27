"""FastAPI backend for the Spotify playlist tools. Wraps the scripts (as
subprocess jobs) and serves dashboard/curation data from the Postgres database.

Run with the project venv:  python -m uvicorn main:app --host 127.0.0.1 --port 8888
(or use web/dev.sh, which reads the port from SPOTIPY_REDIRECT_URI)."""

import asyncio
import json
import os
from typing import Any

import spotipy
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

import db
from auth import _oauth, access_token, auth_status, authorize_url, exchange_code
from config import CALLBACK_PATH, FRONTEND_URL, env_flags
from jobs import registry

app = FastAPI(title="Mixloom API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", FRONTEND_URL],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Status + auth
# --------------------------------------------------------------------------- #
@app.get("/api/status")
def status():
    return {"env": env_flags()}


@app.get("/api/auth/status")
def auth_status_endpoint():
    return auth_status()


@app.get("/api/auth/spotify/login")
def spotify_login(scope: str = Query("read", pattern="^(read|write|player)$")):
    if not env_flags()["spotify"]:
        raise HTTPException(400, "Spotify API keys are not configured in .env.")
    return RedirectResponse(authorize_url(scope))


@app.get("/api/auth/spotify/token")
def spotify_token(scope: str = Query("player", pattern="^(read|write|player)$")):
    """Hand a currently-valid access token to the browser (the Web Playback SDK
    needs one via its getOAuthToken callback)."""
    token = access_token(scope)
    if not token:
        raise HTTPException(401, f"Connect Spotify ({scope}) first.")
    return {"accessToken": token}


@app.get(CALLBACK_PATH)
def spotify_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    scope = state if state in ("read", "write", "player") else "read"
    if error:
        return RedirectResponse(f"{FRONTEND_URL}/?auth={scope}&status=denied")
    if not code:
        return RedirectResponse(f"{FRONTEND_URL}/?auth={scope}&status=missing_code")
    try:
        exchange_code(scope, code)
    except Exception as exc:
        return RedirectResponse(f"{FRONTEND_URL}/?auth={scope}&status=error&detail={exc}")
    return RedirectResponse(f"{FRONTEND_URL}/?auth={scope}&status=connected")


# --------------------------------------------------------------------------- #
# Spotify playlists (read scope) — the live account, for the export step
# --------------------------------------------------------------------------- #
@app.get("/api/spotify/playlists")
def spotify_playlists():
    if not auth_status()["read"]:
        raise HTTPException(401, "Connect Spotify (read scope) first.")
    sp = spotipy.Spotify(auth_manager=_oauth("read"))
    out = []
    try:
        page = sp.current_user_playlists(limit=50)
        while page:
            for pl in page.get("items", []):
                # Some Spotify responses carry the track summary under "items"
                # instead of "tracks"; both are a {href, total} object.
                summary = pl.get("tracks") or pl.get("items") or {}
                total = summary.get("total", 0) if isinstance(summary, dict) else 0
                out.append({
                    "id": pl["id"],
                    "name": pl.get("name") or "Untitled",
                    "tracks": total,
                })
            page = sp.next(page) if page.get("next") else None
    except spotipy.SpotifyException as exc:
        raise HTTPException(502, f"Spotify error: HTTP {exc.http_status} - {exc.msg}")
    return out


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #
class ExportBody(BaseModel):
    playlistIds: list[str]  # Spotify playlist ids


class PlaylistScope(BaseModel):
    playlistIds: list[int] = []  # DB playlist ids; empty = all


class AnalyzeBody(BaseModel):
    audioDir: str
    playlistIds: list[int] = []


class CreateBody(BaseModel):
    playlistId: int
    name: str = ""
    update: bool = False  # update the existing Spotify playlist in place


def _scope_args(playlist_ids: list[int]) -> list[str]:
    return ["--playlists", ",".join(str(i) for i in playlist_ids)] if playlist_ids else []


@app.post("/api/jobs/export")
def job_export(body: ExportBody):
    ids = [i.strip() for i in body.playlistIds if i.strip()]
    if not ids:
        raise HTTPException(400, "Select at least one playlist.")
    job = registry.start("export", [",".join(ids)])
    return {"jobId": job.id}


@app.post("/api/jobs/enrich-countries")
def job_enrich_countries(body: PlaylistScope):
    job = registry.start("enrich-countries", _scope_args(body.playlistIds))
    return {"jobId": job.id}


@app.post("/api/jobs/enrich-features")
def job_enrich_features(body: PlaylistScope):
    job = registry.start("enrich-features", _scope_args(body.playlistIds))
    return {"jobId": job.id}


@app.post("/api/jobs/analyze-local")
def job_analyze_local(body: AnalyzeBody):
    audio_dir = body.audioDir.strip()
    if not audio_dir:
        raise HTTPException(400, "Provide the folder that holds your downloaded tracks.")
    if not os.path.isdir(os.path.expanduser(audio_dir)):
        raise HTTPException(400, f"Audio folder not found: {audio_dir}")
    job = registry.start("analyze-local", [audio_dir, *_scope_args(body.playlistIds)])
    return {"jobId": job.id}


@app.post("/api/jobs/create-playlist")
def job_create_playlist(body: CreateBody):
    args = [str(body.playlistId)]
    if body.name.strip():
        args.append(body.name.strip())
    if body.update:
        args.append("--update")
    # The script prompts "[y/N]"; feed "y" so it proceeds.
    job = registry.start("create-playlist", args, stdin_text="y\n")
    return {"jobId": job.id}


@app.get("/api/jobs")
def jobs_list():
    return registry.list()


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: str):
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found.")
    return {**job.meta(), "lines": job.lines}


@app.get("/api/jobs/{job_id}/stream")
async def job_stream(job_id: str, request: Request):
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found.")

    async def gen():
        sent = 0
        yield _sse({"kind": "status", **job.meta()})
        while True:
            if await request.is_disconnected():
                break
            if sent < len(job.lines):
                batch = job.lines[sent:]
                sent = len(job.lines)
                yield _sse({"kind": "log", "lines": batch})
            if job.status in ("succeeded", "failed"):
                if sent < len(job.lines):
                    continue
                yield _sse({"kind": "done", **job.meta()})
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# --------------------------------------------------------------------------- #
# Playlists / dashboard / rows (from the database)
# --------------------------------------------------------------------------- #
@app.get("/api/playlists")
def playlists():
    return db.list_playlists()


def _ids(playlist_ids: str) -> list[int]:
    return [int(x) for x in playlist_ids.split(",") if x.strip().lstrip("-").isdigit()]


def _json_download(data: list, filename: str) -> JSONResponse:
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/export/artists-missing")
def export_artists_missing(playlistIds: str = Query("")):
    return _json_download(db.missing_artists(_ids(playlistIds)), "artists_missing_country.json")


@app.get("/api/export/tracks-missing")
def export_tracks_missing(playlistIds: str = Query("")):
    return _json_download(db.missing_tracks(_ids(playlistIds)), "tracks_missing_features.json")


@app.get("/api/playlists/{playlist_id}/tracks")
def playlist_tracks_endpoint(playlist_id: int):
    result = db.playlist_tracks(playlist_id)
    if result is None:
        raise HTTPException(404, "Playlist not found.")
    return result


class PlaylistTracksBody(BaseModel):
    uris: list[str]


@app.put("/api/playlists/{playlist_id}/tracks")
def update_playlist_tracks_endpoint(playlist_id: int, body: PlaylistTracksBody):
    if not body.uris:
        raise HTTPException(400, "A playlist needs at least one track.")
    result = db.update_playlist_tracks(playlist_id, body.uris)
    if result is None:
        raise HTTPException(404, "Playlist not found, or not an editable (curated) playlist.")
    return result


@app.delete("/api/playlists/{playlist_id}")
def delete_playlist_endpoint(playlist_id: int):
    """Remove a playlist from the database (does not touch Spotify)."""
    result = db.delete_playlist(playlist_id)
    if result is None:
        raise HTTPException(404, "Playlist not found.")
    return result


def _live_playlist_uris(spotify_id: str) -> list[str]:
    """Fetch the current track URIs of a Spotify playlist (read scope)."""
    sp = spotipy.Spotify(auth_manager=_oauth("read"))
    uris: list[str] = []
    page = sp.playlist_items(spotify_id, limit=50, additional_types=("track",))
    while page:
        for entry in page.get("items", []):
            track = entry.get("track") or entry.get("item") or {}
            uri = track.get("uri") or ""
            if uri.startswith("spotify:track:"):
                uris.append(uri)
        page = sp.next(page) if page.get("next") else None
    return uris


@app.get("/api/playlists/{playlist_id}/resync")
def playlist_resync_status(playlist_id: int):
    """Diff an exported playlist's DB mirror against its live Spotify contents,
    so drift (tracks added/removed on Spotify since export) is visible."""
    mirror = db.playlist_mirror(playlist_id)
    if mirror is None:
        raise HTTPException(404, "Playlist not found.")
    if not mirror["spotifyId"]:
        raise HTTPException(400, "This playlist has no Spotify source (it was curated in-app).")
    if not auth_status()["read"]:
        raise HTTPException(401, "Connect Spotify (read scope) first.")
    try:
        live = _live_playlist_uris(mirror["spotifyId"])
    except spotipy.SpotifyException as exc:
        raise HTTPException(502, f"Spotify error: HTTP {exc.http_status} - {exc.msg}")

    db_set, live_set = set(mirror["uris"]), set(live)
    added_uris = [u for u in live if u not in db_set]      # on Spotify, not in DB
    removed_uris = [u for u in mirror["uris"] if u not in live_set]  # in DB, not on Spotify
    known = db.tracks_by_uri(added_uris + removed_uris)

    def label(uri: str) -> dict:
        t = known.get(uri, {})
        return {"uri": uri, "title": t.get("title", ""), "artists": t.get("artists", "")}

    return {
        "spotifyId": mirror["spotifyId"],
        "inSync": not added_uris and not removed_uris,
        "dbCount": len(mirror["uris"]),
        "liveCount": len(live),
        "added": [label(u) for u in added_uris],
        "removed": [label(u) for u in removed_uris],
    }


@app.get("/api/stats")
def stats_endpoint(playlistId: int | None = Query(None)):
    result = db.stats(playlistId)
    if result is None:
        raise HTTPException(404, "Playlist not found.")
    return result


@app.get("/api/rows")
def rows_endpoint(
    playlistId: int | None = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    q: str = Query(""),
):
    result = db.rows(playlistId, offset, limit, q)
    if result is None:
        raise HTTPException(404, "Playlist not found.")
    return result


# --------------------------------------------------------------------------- #
# Curation
# --------------------------------------------------------------------------- #
class CurateSaveBody(BaseModel):
    name: str
    uris: list[str]


@app.get("/api/curate/tracks")
def curate_tracks(playlistIds: str = Query("")):
    ids = [int(x) for x in playlistIds.split(",") if x.strip().lstrip("-").isdigit()]
    return db.curate_tracks(ids)


@app.post("/api/curate/save")
def curate_save(body: CurateSaveBody):
    if not body.name.strip():
        raise HTTPException(400, "Playlist name is required.")
    if not body.uris:
        raise HTTPException(400, "Select at least one track.")
    result = db.save_curated(body.name.strip(), body.uris)
    if result is None:
        raise HTTPException(404, "None of the selected tracks are in the database.")
    return result


# --------------------------------------------------------------------------- #
# Library intelligence
# --------------------------------------------------------------------------- #
@app.get("/api/tracks/similar")
def tracks_similar(uri: str = Query(...), limit: int = Query(20, ge=1, le=100)):
    result = db.find_similar(uri, limit)
    if result is None:
        raise HTTPException(404, "Track not found in the database.")
    return result


@app.get("/api/tracks")
def tracks_list(
    playlistId: int | None = Query(None),
    missing: bool = Query(False),
    orphan: bool = Query(False),
    q: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    """Tracks with their full editable metadata, for the metadata editor."""
    result = db.list_tracks_detail(playlistId, missing, q, offset, limit, orphan_only=orphan)
    if result is None:
        raise HTTPException(404, "Playlist not found.")
    return result


@app.get("/api/tracks/field-options")
def track_field_options():
    """Distinct existing genre/mood values for the editor's suggestion lists."""
    return db.track_field_options()


class TrackUpdateBody(BaseModel):
    fields: dict[str, Any]


@app.put("/api/tracks/{track_id}")
def track_update(track_id: int, body: TrackUpdateBody):
    """Apply hand edits to one track's metadata (null/empty clears a field)."""
    result = db.update_track_metadata(track_id, body.fields)
    if result is None:
        raise HTTPException(404, "Track not found.")
    return result


@app.delete("/api/tracks/{track_id}")
def track_delete(track_id: int):
    """Remove a single track from the library (does not touch Spotify)."""
    result = db.delete_track(track_id)
    if result is None:
        raise HTTPException(404, "Track not found.")
    return result


@app.get("/api/duplicates")
def duplicates_endpoint():
    return db.duplicates()


@app.get("/api/library-health")
def library_health_endpoint():
    return db.library_health()


# --------------------------------------------------------------------------- #
# Saved filters (smart playlists)
# --------------------------------------------------------------------------- #
class SavedFilterBody(BaseModel):
    name: str
    rules: dict


@app.get("/api/saved-filters")
def saved_filters_list():
    return db.list_saved_filters()


@app.post("/api/saved-filters")
def saved_filters_create(body: SavedFilterBody):
    if not body.name.strip():
        raise HTTPException(400, "Filter name is required.")
    return db.save_filter(body.name.strip(), body.rules)


@app.delete("/api/saved-filters/{filter_id}")
def saved_filters_delete(filter_id: int):
    if not db.delete_filter(filter_id):
        raise HTTPException(404, "Saved filter not found.")
    return {"deleted": filter_id}
