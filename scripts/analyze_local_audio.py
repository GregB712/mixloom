#!/usr/bin/env python3
"""Fill audio-feature metadata for tracks the APIs could not return, by analysing
downloaded audio files (librosa), writing results to the Postgres DB.

Matches each feature-less track in the DB to a local audio file, analyses it,
and updates the track. Optionally restrict to one or more playlists.

Honesty note: only some columns are faithfully derivable from raw audio
(bpm, key/mode/camelot/open_key, loudness_db, and an energy proxy). The
perceptual fields (danceability, valence, speechiness, instrumentalness,
liveness, acousticness) are ROUGH HEURISTIC ESTIMATES. Updated tracks are
tagged feature_source='local-estimate'.

Usage:
    python analyze_local_audio.py <audio_dir> [--playlists 1,2,3] [--all]
                                  [--seconds N] [--database-url URL]

    --all        re-analyse tracks even if they already have features.
    --seconds N  analyse only the first N seconds of each file (default 180; 0 = whole).

Requires: librosa, numpy (always); mutagen (optional, tags); ffmpeg to decode
.mp3/.m4a (.wav/.flac/.ogg decode without it).
"""

import argparse
import re
import unicodedata
from pathlib import Path

import dbutil

AUDIO_EXTS = {".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac", ".wma"}

KEY_TABLE = [
    ("C",  "8B",  "1d",  "5A",  "10m"), ("C#", "3B",  "8d",  "12A", "5m"),
    ("D",  "10B", "3d",  "7A",  "12m"), ("Eb", "5B",  "10d", "2A",  "7m"),
    ("E",  "12B", "5d",  "9A",  "2m"),  ("F",  "7B",  "12d", "4A",  "9m"),
    ("F#", "2B",  "7d",  "11A", "4m"),  ("G",  "9B",  "2d",  "6A",  "11m"),
    ("Ab", "4B",  "9d",  "1A",  "6m"),  ("A",  "11B", "4d",  "8A",  "1m"),
    ("Bb", "6B",  "11d", "3A",  "8m"),  ("B",  "1B",  "6d",  "10A", "3m"),
]
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

_NOISE_TOKENS = {
    "official", "video", "audio", "lyrics", "lyric", "hd", "hq", "4k", "mv",
    "visualizer", "visualiser", "remaster", "remastered", "explicit",
}


def norm(text: str) -> str:
    s = unicodedata.normalize("NFKC", text or "").casefold()
    s = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", s)
    s = re.sub(r"\b(feat|ft|featuring)\.?\b.*", " ", s)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    return " ".join(t for t in s.split() if t not in _NOISE_TOKENS).strip()


# --------------------------------------------------------------------------- #
# File index + matching
# --------------------------------------------------------------------------- #
def read_tags(path: Path) -> dict:
    try:
        from mutagen import File as MutagenFile
    except ImportError:
        return {}
    try:
        audio = MutagenFile(path, easy=True)
    except Exception:
        return {}
    if audio is None:
        return {}

    def first(*keys: str) -> str:
        tags = getattr(audio, "tags", None) or {}
        for key in keys:
            val = tags.get(key)
            if val:
                return (val[0] if isinstance(val, list) else str(val)).strip()
        return ""

    return {
        "artist": first("artist", "albumartist"),
        "title": first("title"),
        "isrc": first("isrc").upper().replace("-", ""),
    }


def index_files(audio_dir: Path) -> list[dict]:
    files = []
    for path in sorted(audio_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTS:
            continue
        tags = read_tags(path)
        files.append({
            "path": path,
            "isrc": tags.get("isrc", ""),
            "hay": norm(f"{tags.get('artist','')} {tags.get('title','')} {path.stem}"),
            "at_key": f"{norm(tags.get('artist',''))}|{norm(tags.get('title',''))}"
                      if tags.get("artist") and tags.get("title") else None,
        })
    return files


def build_match(track: dict, files: list[dict], isrc_map: dict, at_map: dict):
    isrc = (track.get("isrc") or "").strip().upper().replace("-", "")
    if isrc and isrc in isrc_map:
        return isrc_map[isrc]
    title = norm(track.get("title", ""))
    artist = norm((track.get("artists_text") or "").split(", ", 1)[0])
    if not title:
        return None
    if f"{artist}|{title}" in at_map:
        return at_map[f"{artist}|{title}"]
    artist_tok = artist.split(" ", 1)[0] if artist else ""
    for f in files:
        if title in f["hay"] and (not artist_tok or artist_tok in f["hay"]):
            return f
    return None


# --------------------------------------------------------------------------- #
# Audio analysis
# --------------------------------------------------------------------------- #
def detect_key(chroma_mean) -> tuple[int, bool]:
    import numpy as np
    best_pc, best_major, best_corr = 0, True, -2.0
    for major, profile in ((True, MAJOR_PROFILE), (False, MINOR_PROFILE)):
        prof = np.array(profile)
        for pc in range(12):
            corr = float(np.corrcoef(chroma_mean, np.roll(prof, pc))[0, 1])
            if corr > best_corr:
                best_corr, best_pc, best_major = corr, pc, major
    return best_pc, best_major


def analyze(path: Path, seconds: int) -> dict | None:
    import numpy as np
    import librosa

    try:
        duration = seconds if seconds and seconds > 0 else None
        y, sr = librosa.load(path, sr=22050, mono=True, duration=duration)
    except Exception as exc:
        print(f"    ! could not decode ({exc.__class__.__name__}: {exc})")
        return None
    if y.size < sr:
        print("    ! too short to analyse")
        return None

    def clip01(x: float) -> float:
        return float(max(0.0, min(1.0, x)))

    tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
    bpm = round(float(np.atleast_1d(tempo)[0]), 2)

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    pc, is_major = detect_key(chroma)
    name, cam_maj, open_maj, cam_min, open_min = KEY_TABLE[pc]
    key = f"{name}-{'Major' if is_major else 'Minor'}"

    rms = float(np.mean(librosa.feature.rms(y=y)))
    loudness_db = round(float(librosa.amplitude_to_db(np.array([rms]), ref=1.0)[0]), 2)
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(y)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    pulse = clip01(float(np.mean(librosa.onset.onset_strength(y=y, sr=sr))) / 4.0)

    loud_norm = clip01((loudness_db + 60.0) / 60.0)
    centroid_norm = clip01(centroid / 4000.0)
    tempo_score = clip01(1.0 - abs(bpm - 120.0) / 80.0)

    energy = round(clip01(0.6 * loud_norm + 0.4 * centroid_norm), 4)
    danceability = round(clip01(0.5 * tempo_score + 0.3 * loud_norm + 0.2 * pulse), 4)
    valence = round(clip01(0.4 * centroid_norm + 0.3 * (1.0 if is_major else 0.35) + 0.3 * tempo_score), 4)
    speechiness = round(clip01(0.5 * clip01(zcr / 0.2) + 0.5 * flatness) * 0.4, 4)
    instrumentalness = round(clip01(flatness * 2.0), 4)
    liveness = round(clip01(0.08 + 0.25 * flatness), 4)
    acousticness = round(clip01(0.7 * (1.0 - energy) + 0.3 * (1.0 - centroid_norm)), 4)

    return {
        "bpm": bpm, "key": key, "mode": 1 if is_major else 0,
        "camelot": cam_maj if is_major else cam_min,
        "open_key": open_maj if is_major else open_min,
        "energy": energy, "loudness_db": loudness_db, "danceability": danceability,
        "valence": valence, "speechiness": speechiness,
        "instrumentalness": instrumentalness, "liveness": liveness,
        "acousticness": acousticness, "time_signature": 4,
        "feature_source": "local-estimate",
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def select_tracks(cur, playlist_ids: list[int], include_all: bool) -> list[dict]:
    where = [] if include_all else ["t.feature_source IS NULL"]
    params: list = []
    if playlist_ids:
        where.append(
            "EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id "
            "AND pt.playlist_id = ANY(%s))"
        )
        params.append(playlist_ids)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    cur.execute(
        f"SELECT t.id, t.title, t.artists_text, t.isrc FROM tracks t{clause} ORDER BY t.id",
        params,
    )
    return [{"id": r[0], "title": r[1], "artists_text": r[2], "isrc": r[3]} for r in cur.fetchall()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Fill audio features from local files into the DB.")
    parser.add_argument("audio_dir")
    parser.add_argument("--playlists", default="", help="comma-separated playlist ids (default: all)")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    try:
        import numpy  # noqa: F401
        import librosa  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            f"Missing audio library: {exc.name}. Install with:\n"
            "    pip install librosa mutagen\n"
            "(and ensure ffmpeg is on PATH to decode .mp3/.m4a)."
        )
    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")

    audio_dir = Path(args.audio_dir).expanduser()
    if not audio_dir.is_dir():
        raise SystemExit(f"Audio folder not found: {audio_dir}")
    playlist_ids = [int(p) for p in args.playlists.split(",") if p.strip()]

    try:
        conn = dbutil.connect(args.database_url)
    except Exception as exc:
        raise SystemExit(f"Could not connect to the database: {exc}")

    with conn:
        with conn.cursor() as cur:
            tracks = select_tracks(cur, playlist_ids, args.all)
        scope = f"playlists {playlist_ids}" if playlist_ids else "all playlists"
        print(f"Scope: {scope} | tracks to analyse: {len(tracks)}")
        if not tracks:
            print("Nothing to do.")
            return

        print("Indexing audio files…")
        files = index_files(audio_dir)
        print(f"Found {len(files)} audio file(s).")
        if not files:
            raise SystemExit("No audio files found; nothing to match against.")
        isrc_map = {f["isrc"]: f for f in files if f["isrc"]}
        at_map = {f["at_key"]: f for f in files if f["at_key"]}

        matched = analysed = unmatched = failed = 0
        for i, track in enumerate(tracks, 1):
            label = f"{(track.get('artists_text') or '?')} – {track.get('title') or '?'}"
            match = build_match(track, files, isrc_map, at_map)
            if match is None:
                unmatched += 1
                print(f"[{i}/{len(tracks)}] no local file for: {label}")
                continue
            matched += 1
            print(f"[{i}/{len(tracks)}] {label}  ->  {match['path'].name}")
            feats = analyze(match["path"], args.seconds)
            if feats is None:
                failed += 1
                continue
            with conn.cursor() as cur:
                dbutil.update_track_features(cur, track["id"], feats)
            conn.commit()
            analysed += 1
            print(f"    bpm={feats['bpm']} key={feats['key']} camelot={feats['camelot']} "
                  f"energy={feats['energy']} (perceptual fields are estimates)")

    print("\nFinished.")
    print(f"Matched: {matched} | analysed: {analysed} | no file: {unmatched} | decode failed: {failed}")


if __name__ == "__main__":
    main()
