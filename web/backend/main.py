"""FastAPI backend for the Spotify playlist tools. Wraps the scripts (as
subprocess jobs) and serves dashboard/curation data from the Postgres database.

Run with the project venv:  python -m uvicorn main:app --host 127.0.0.1 --port 8888
(or use web/dev.sh, which reads the port from SPOTIPY_REDIRECT_URI)."""

import asyncio
import json
import os

import spotipy
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

import db
from auth import access_token, auth_status, authorize_url, exchange_code, _oauth
from config import CALLBACK_PATH, FRONTEND_URL, env_flags
from jobs import registry

app = FastAPI(title="Spotify Playlist Tools API")

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
