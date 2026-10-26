"""Postgres-backed queries for the dashboard and curation UI.

Replaces the old CSV reader. All data now lives in the metadata database; a
"scope" is either the whole library (playlist_id=None) or one playlist.
"""

import math

import psycopg

from config import DATABASE_URL

NUMERIC_FEATURES = [
    "bpm", "energy", "loudness_db", "danceability", "valence",
    "speechiness", "instrumentalness", "liveness", "acousticness",
]


def _connect():
    return psycopg.connect(DATABASE_URL)


# --------------------------------------------------------------------------- #
# Playlists
# --------------------------------------------------------------------------- #
def list_playlists() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.spotify_id, p.name, p.curated, p.spotify_playlist_id,
                   count(pt.track_id) AS tracks,
                   count(t.feature_source) AS with_features,
                   (SELECT count(DISTINCT ta.artist_id)
                      FROM playlist_tracks pt2 JOIN track_artists ta ON ta.track_id = pt2.track_id
                      WHERE pt2.playlist_id = p.id) AS artist_count,
                   (SELECT count(DISTINCT ta.artist_id)
                      FROM playlist_tracks pt2 JOIN track_artists ta ON ta.track_id = pt2.track_id
                      JOIN artists a ON a.id = ta.artist_id
                      WHERE pt2.playlist_id = p.id AND a.country_code IS NOT NULL) AS artists_resolved
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
            LEFT JOIN tracks t ON t.id = pt.track_id
            GROUP BY p.id
            ORDER BY p.curated, lower(p.name)
            """
        ).fetchall()
    return [
        {
            "id": r[0], "spotifyId": r[1], "name": r[2], "curated": r[3],
            "spotifyPlaylistId": r[4],
            "trackCount": r[5], "withFeatures": r[6],
            "artistCount": r[7], "artistsResolved": r[8],
            # kept for the dashboard "countries" badge
            "withCountries": r[8],
        }
        for r in rows
    ]


def _scope_ids(conn, playlist_id: int | None) -> list[int] | None:
    """Track ids in scope. None playlist => whole library (returns all ids).
    Returns None if the playlist id does not exist."""
    if playlist_id is None:
        rows = conn.execute("SELECT id FROM tracks").fetchall()
        return [r[0] for r in rows]
    exists = conn.execute("SELECT 1 FROM playlists WHERE id = %s", (playlist_id,)).fetchone()
    if not exists:
        return None
    rows = conn.execute(
        "SELECT track_id FROM playlist_tracks WHERE playlist_id = %s", (playlist_id,)
    ).fetchall()
    return [r[0] for r in rows]


def playlist_tracks(playlist_id: int) -> list[dict] | None:
    """Ordered, playable tracks of one playlist (for the Player tab). Returns
    None if the playlist does not exist; keeps only rows with a track URI."""
    with _connect() as conn:
        exists = conn.execute(
            "SELECT 1 FROM playlists WHERE id = %s", (playlist_id,)
        ).fetchone()
        if not exists:
            return None
        rows = conn.execute(
            """
            SELECT t.spotify_uri, t.title, t.artists_text, t.album, t.duration_ms,
                   t.album_art_url
            FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
            WHERE pt.playlist_id = %s AND t.spotify_uri LIKE 'spotify:track:%%'
            ORDER BY pt.position, lower(t.title)
            """,
            (playlist_id,),
        ).fetchall()
    return [
        {
            "uri": r[0], "title": r[1] or "", "artists": r[2] or "",
            "album": r[3] or "", "durationMs": r[4], "albumArt": r[5],
        }
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# Stats
# --------------------------------------------------------------------------- #
def _histogram(values: list[float], bins: int = 24) -> dict | None:
    import numpy as np
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    lo, hi = float(min(vals)), float(max(vals))
    if math.isclose(lo, hi):
        return {"bins": [{"x0": lo, "x1": hi, "count": len(vals)}]}
    counts, edges = np.histogram(np.array(vals), bins=bins, range=(lo, hi))
    return {"bins": [
        {"x0": round(float(edges[i]), 3), "x1": round(float(edges[i + 1]), 3), "count": int(counts[i])}
        for i in range(len(counts))
    ]}


def stats(playlist_id: int | None) -> dict | None:
    with _connect() as conn:
        ids = _scope_ids(conn, playlist_id)
        if ids is None:
            return None
        total = len(ids)
        name = "All playlists"
        if playlist_id is not None:
            row = conn.execute("SELECT name FROM playlists WHERE id = %s", (playlist_id,)).fetchone()
            name = row[0] if row else "Playlist"

        metrics: dict = {"tracks": total}
        if total:
            agg = conn.execute(
                """
                SELECT count(DISTINCT album) FILTER (WHERE album IS NOT NULL),
                       coalesce(sum(duration_ms), 0),
                       count(feature_source),
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY bpm)
                FROM tracks WHERE id = ANY(%s)
                """,
                (ids,),
            ).fetchone()
            metrics["uniqueAlbums"] = int(agg[0] or 0)
            metrics["totalDurationMs"] = int(agg[1] or 0)
            matched = int(agg[2] or 0)
            metrics["medianBpm"] = round(float(agg[3]), 1) if agg[3] is not None else None

            metrics["uniqueArtists"] = int(conn.execute(
                "SELECT count(DISTINCT artist_id) FROM track_artists WHERE track_id = ANY(%s)",
                (ids,),
            ).fetchone()[0])

            greek = int(conn.execute(
                """SELECT count(*) FROM tracks t WHERE t.id = ANY(%s) AND EXISTS (
                     SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                     WHERE ta.track_id = t.id AND a.country_code = 'GR')""",
                (ids,),
            ).fetchone()[0])
            metrics["greekCount"] = greek
            metrics["greekPct"] = round(greek / total * 100, 1)
        else:
            matched = 0

        with_countries = total and bool(conn.execute(
            """SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
               WHERE ta.track_id = ANY(%s) AND a.country_code IS NOT NULL LIMIT 1""",
            (ids,),
        ).fetchone())

        result: dict = {
            "name": name,
            "rows": total,
            "groups": {"base": True, "countries": bool(with_countries), "features": matched > 0},
            "metrics": metrics,
        }

        # Top artists.
        result["topArtists"] = [
            {"label": r[0], "value": int(r[1])}
            for r in conn.execute(
                """SELECT a.name, count(*) FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                   WHERE ta.track_id = ANY(%s) GROUP BY a.name ORDER BY count(*) DESC, a.name LIMIT 15""",
                (ids,),
            ).fetchall()
        ]

        # Playlist distribution (whole-library view only).
        if playlist_id is None and total:
            result["sourcePlaylists"] = [
                {"label": r[0], "value": int(r[1])}
                for r in conn.execute(
                    """SELECT p.name, count(*) FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
                       GROUP BY p.name ORDER BY count(*) DESC LIMIT 15"""
                ).fetchall()
            ]

        # Countries.
        if with_countries:
            country: dict = {}
            country["topCountries"] = [
                {"label": r[0], "value": int(r[1])}
                for r in conn.execute(
                    """SELECT a.country_code, count(DISTINCT a.id) FROM track_artists ta
                       JOIN artists a ON a.id = ta.artist_id
                       WHERE ta.track_id = ANY(%s) AND a.country_code IS NOT NULL
                       GROUP BY a.country_code ORDER BY count(DISTINCT a.id) DESC LIMIT 15""",
                    (ids,),
                ).fetchall()
            ]
            country["status"] = [
                {"label": r[0] or "unknown", "value": int(r[1])}
                for r in conn.execute(
                    """SELECT coalesce(a.country_status, 'unknown'), count(DISTINCT a.id)
                       FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                       WHERE ta.track_id = ANY(%s) GROUP BY 1 ORDER BY 2 DESC""",
                    (ids,),
                ).fetchall()
            ]
            result["countries"] = country

        # Audio features.
        if matched > 0:
            audio: dict = {"matched": matched, "matchRate": round(matched / total * 100, 1)}
            feature_rows = conn.execute(
                f"SELECT {', '.join(NUMERIC_FEATURES)} FROM tracks "
                f"WHERE id = ANY(%s) AND feature_source IS NOT NULL",
                (ids,),
            ).fetchall()
            histograms = {}
            for col_i, feat in enumerate(NUMERIC_FEATURES):
                hist = _histogram([row[col_i] for row in feature_rows])
                if hist:
                    histograms[feat] = hist
            audio["histograms"] = histograms
            categories: dict = {}
            for cat in ("camelot", "genre", "mood"):
                counts = conn.execute(
                    f"SELECT {cat}, count(*) FROM tracks WHERE id = ANY(%s) AND {cat} IS NOT NULL "
                    f"GROUP BY {cat} ORDER BY count(*) DESC LIMIT 24",
                    (ids,),
                ).fetchall()
                if counts:
                    categories[cat] = [{"label": str(r[0]), "value": int(r[1])} for r in counts]
            if categories:
                audio["categories"] = categories
            result["audio"] = audio

        return result


# --------------------------------------------------------------------------- #
# Rows (dashboard table)
# --------------------------------------------------------------------------- #
ROW_COLUMNS = [
    "title", "artists_text", "album", "duration_ms", "isrc", "release_date",
    "bpm", "key", "camelot", "energy", "danceability", "valence", "mood",
    "genre", "feature_source", "spotify_uri",
]


def rows(playlist_id: int | None, offset: int, limit: int, query: str) -> dict | None:
    with _connect() as conn:
        ids = _scope_ids(conn, playlist_id)
        if ids is None:
            return None
        where = ["t.id = ANY(%s)"]
        params: list = [ids]
        if query.strip():
            where.append("(lower(t.title) LIKE %s OR lower(t.artists_text) LIKE %s)")
            like = f"%{query.strip().lower()}%"
            params += [like, like]
        clause = " AND ".join(where)
        total = conn.execute(f"SELECT count(*) FROM tracks t WHERE {clause}", params).fetchone()[0]
        select_cols = ", ".join(f"t.{c}" for c in ROW_COLUMNS)
        window = conn.execute(
            f"SELECT {select_cols} FROM tracks t WHERE {clause} "
            f"ORDER BY lower(t.title) OFFSET %s LIMIT %s",
            params + [offset, limit],
        ).fetchall()
    return {
        "columns": ROW_COLUMNS,
        "rows": [
            {c: ("" if v is None else str(v)) for c, v in zip(ROW_COLUMNS, row)}
            for row in window
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


# --------------------------------------------------------------------------- #
# Curation
# --------------------------------------------------------------------------- #
def _num(v) -> float | None:
    return round(float(v), 4) if v is not None else None


def _scope_ids_multi(conn, playlist_ids: list[int]) -> list[int]:
    """Track ids across several playlists (union, deduplicated). Empty list =>
    the whole library."""
    if not playlist_ids:
        return [r[0] for r in conn.execute("SELECT id FROM tracks").fetchall()]
    return [
        r[0] for r in conn.execute(
            "SELECT DISTINCT track_id FROM playlist_tracks WHERE playlist_id = ANY(%s)",
            (playlist_ids,),
        ).fetchall()
    ]


def curate_tracks(playlist_ids: list[int]) -> dict:
    with _connect() as conn:
        ids = _scope_ids_multi(conn, playlist_ids)
        if not playlist_ids:
            name = "All playlists"
        else:
            names = conn.execute(
                "SELECT name FROM playlists WHERE id = ANY(%s) ORDER BY lower(name)",
                (playlist_ids,),
            ).fetchall()
            name = names[0][0] if len(names) == 1 else f"{len(names)} playlists"
        rows = conn.execute(
            """
            SELECT t.spotify_uri, t.title, t.artists_text, t.album, t.duration_ms,
                   t.bpm, t.energy, t.valence, t.danceability, t.acousticness,
                   t.camelot, t.key, t.genre, t.mood, t.album_art_url,
                   EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                           WHERE ta.track_id = t.id AND a.country_code = 'GR') AS greek
            FROM tracks t
            WHERE t.id = ANY(%s) AND t.spotify_uri LIKE 'spotify:track:%%'
            ORDER BY lower(t.title)
            """,
            (ids,),
        ).fetchall()
    out = [
        {
            "uri": r[0], "title": r[1] or "", "artists": r[2] or "", "album": r[3] or "",
            "durationMs": _num(r[4]), "bpm": _num(r[5]), "energy": _num(r[6]),
            "valence": _num(r[7]), "danceability": _num(r[8]), "acousticness": _num(r[9]),
            "camelot": r[10], "musicalKey": r[11], "genre": r[12], "mood": r[13],
            "albumArt": r[14], "greek": bool(r[15]),
        }
        for r in rows
    ]
    has_features = any(t["bpm"] is not None or t["energy"] is not None for t in out)
    return {"name": name, "hasUris": True, "hasFeatures": has_features, "tracks": out}


# Fillable audio-feature fields offered in the tracks export template
# (feature_source is set by the importer, not filled by hand).
TRACK_TEMPLATE_FIELDS = [
    "bpm", "bpm_confidence", "key", "key_confidence", "mode", "camelot",
    "open_key", "energy", "loudness_db", "danceability", "valence",
    "speechiness", "instrumentalness", "liveness", "acousticness",
    "time_signature", "mood", "genre",
]


def missing_artists(playlist_ids: list[int]) -> list[dict]:
    """Artists without a resolved country, as a hand-fillable template."""
    with _connect() as conn:
        if playlist_ids:
            rows = conn.execute(
                """SELECT DISTINCT a.id, a.name FROM artists a
                   JOIN track_artists ta ON ta.artist_id = a.id
                   JOIN playlist_tracks pt ON pt.track_id = ta.track_id
                   WHERE a.country_code IS NULL AND pt.playlist_id = ANY(%s)
                   ORDER BY a.name""",
                (playlist_ids,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name FROM artists WHERE country_code IS NULL ORDER BY name"
            ).fetchall()
    return [{"id": r[0], "name": r[1], "country_code": "", "country_name": ""} for r in rows]


def missing_tracks(playlist_ids: list[int]) -> list[dict]:
    """Tracks without audio features, as a hand-fillable template."""
    base = ["id", "spotify_uri", "title", "artists_text"]
    with _connect() as conn:
        if playlist_ids:
            rows = conn.execute(
                f"""SELECT DISTINCT {', '.join('t.' + c for c in base)} FROM tracks t
                    JOIN playlist_tracks pt ON pt.track_id = t.id
                    WHERE t.feature_source IS NULL AND pt.playlist_id = ANY(%s)
                    ORDER BY lower(t.title)""",
                (playlist_ids,),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {', '.join(base)} FROM tracks WHERE feature_source IS NULL "
                f"ORDER BY lower(title)"
            ).fetchall()
    out = []
    for r in rows:
        rec = {"id": r[0], "spotify_uri": r[1], "title": r[2], "artists": r[3]}
        for f in TRACK_TEMPLATE_FIELDS:
            rec[f] = None
        out.append(rec)
    return out


def save_curated(name: str, uris: list[str]) -> dict | None:
    """Create a curated playlist in the DB from the given ordered track URIs."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spotify_uri, id FROM tracks WHERE spotify_uri = ANY(%s)", (uris,)
            )
            by_uri = {r[0]: r[1] for r in cur.fetchall()}
            ordered = [(u, by_uri[u]) for u in uris if u in by_uri]
            if not ordered:
                return None
            cur.execute(
                "INSERT INTO playlists (name, curated) VALUES (%s, TRUE) RETURNING id", (name,)
            )
            pid = cur.fetchone()[0]
            for position, (_, track_id) in enumerate(ordered):
                cur.execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position) "
                    "VALUES (%s, %s, %s)",
                    (pid, track_id, position),
                )
        conn.commit()
    return {"playlistId": pid, "name": name, "count": len(ordered)}


def update_playlist_tracks(playlist_id: int, uris: list[str]) -> dict | None:
    """Replace a curated playlist's tracks with the given ordered URIs (edit in
    place). Returns None if the playlist does not exist, is not curated, or none
    of the URIs resolve to a track."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT curated FROM playlists WHERE id = %s", (playlist_id,))
            row = cur.fetchone()
            if row is None or not row[0]:
                return None
            cur.execute(
                "SELECT spotify_uri, id FROM tracks WHERE spotify_uri = ANY(%s)", (uris,)
            )
            by_uri = {r[0]: r[1] for r in cur.fetchall()}
            ordered = [(u, by_uri[u]) for u in uris if u in by_uri]
            if not ordered:
                return None
            cur.execute("DELETE FROM playlist_tracks WHERE playlist_id = %s", (playlist_id,))
            for position, (_, track_id) in enumerate(ordered):
                cur.execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position) "
                    "VALUES (%s, %s, %s)",
                    (playlist_id, track_id, position),
                )
        conn.commit()
    return {"playlistId": playlist_id, "count": len(ordered)}


def playlist_mirror(playlist_id: int) -> dict | None:
    """The DB mirror of an exported playlist: its Spotify id and the set of
    track URIs it currently holds. None if the playlist doesn't exist."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT spotify_id, name FROM playlists WHERE id = %s", (playlist_id,)
        ).fetchone()
        if row is None:
            return None
        uris = [
            r[0] for r in conn.execute(
                """SELECT t.spotify_uri FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                   WHERE pt.playlist_id = %s AND t.spotify_uri LIKE 'spotify:track:%%'""",
                (playlist_id,),
            ).fetchall()
        ]
    return {"spotifyId": row[0], "name": row[1], "uris": uris}


def tracks_by_uri(uris: list[str]) -> dict[str, dict]:
    """Minimal {uri: {title, artists}} lookup for the URIs the DB knows."""
    if not uris:
        return {}
    with _connect() as conn:
        rows = conn.execute(
            "SELECT spotify_uri, title, artists_text FROM tracks WHERE spotify_uri = ANY(%s)",
            (uris,),
        ).fetchall()
    return {r[0]: {"title": r[1] or "", "artists": r[2] or ""} for r in rows}


def delete_playlist(playlist_id: int) -> dict | None:
    """Delete a playlist (exported or curated) from the database. Its
    playlist_tracks links go via cascade; tracks that are left in no playlist
    (and artists left on no track) are then cleaned up, so the shared library
    doesn't accumulate orphans. Tracks still used by another playlist are kept.
    Returns None if the playlist does not exist."""
    with _connect() as conn:
        with conn.cursor() as cur:
            row = cur.execute(
                "SELECT name FROM playlists WHERE id = %s", (playlist_id,)
            ).fetchone()
            if row is None:
                return None
            name = row[0]
            cur.execute("DELETE FROM playlists WHERE id = %s", (playlist_id,))
            removed_tracks = cur.execute(
                "DELETE FROM tracks WHERE id NOT IN "
                "(SELECT track_id FROM playlist_tracks) RETURNING id"
            ).rowcount
            removed_artists = cur.execute(
                "DELETE FROM artists WHERE id NOT IN "
                "(SELECT artist_id FROM track_artists) RETURNING id"
            ).rowcount
        conn.commit()
    return {
        "playlistId": playlist_id,
        "name": name,
        "removedTracks": removed_tracks,
        "removedArtists": removed_artists,
    }


def set_spotify_playlist_id(playlist_id: int, spotify_playlist_id: str) -> None:
    """Record the Spotify id of the playlist a push created, so later pushes can
    update that playlist in place instead of creating a new one."""
    with _connect() as conn:
        conn.execute(
            "UPDATE playlists SET spotify_playlist_id = %s, updated_at = now() WHERE id = %s",
            (spotify_playlist_id, playlist_id),
        )
        conn.commit()


# --------------------------------------------------------------------------- #
# Library intelligence
# --------------------------------------------------------------------------- #
# Feature columns used for nearest-neighbour similarity, with a per-feature
# weight (tempo and energy dominate how two tracks "mix").
SIMILARITY_FEATURES = {
    "bpm": 1.5, "energy": 1.3, "valence": 1.0, "danceability": 1.0,
    "acousticness": 0.8, "instrumentalness": 0.6, "loudness_db": 0.6,
}


def _track_payload(r: tuple) -> dict:
    """Shared track shape for similarity/duplicate results (matches curate rows)."""
    return {
        "uri": r[0], "title": r[1] or "", "artists": r[2] or "", "album": r[3] or "",
        "durationMs": _num(r[4]), "bpm": _num(r[5]), "energy": _num(r[6]),
        "valence": _num(r[7]), "danceability": _num(r[8]), "acousticness": _num(r[9]),
        "camelot": r[10], "musicalKey": r[11], "genre": r[12], "mood": r[13],
        "albumArt": r[14], "greek": bool(r[15]),
    }


_TRACK_SELECT = """
    SELECT t.spotify_uri, t.title, t.artists_text, t.album, t.duration_ms,
           t.bpm, t.energy, t.valence, t.danceability, t.acousticness,
           t.camelot, t.key, t.genre, t.mood, t.album_art_url,
           EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                   WHERE ta.track_id = t.id AND a.country_code = 'GR') AS greek
"""


def find_similar(uri: str, limit: int = 20) -> dict | None:
    """Nearest-neighbour tracks to `uri` over the normalized audio-feature
    vector (local, no external API). Returns the seed plus ranked neighbours, or
    None if the seed track is unknown. If the seed lacks features, returns an
    empty neighbour list with hasFeatures False."""
    feats = list(SIMILARITY_FEATURES)
    with _connect() as conn:
        seed_row = conn.execute(
            f"SELECT id, {', '.join(feats)} FROM tracks WHERE spotify_uri = %s", (uri,)
        ).fetchone()
        if seed_row is None:
            return None
        seed_id = seed_row[0]
        seed_vals = {f: seed_row[i + 1] for i, f in enumerate(feats)}
        # Compare only over the features the seed actually has; a track missing
        # one feature still counts as having features for the rest.
        usable_feats = [f for f in feats if seed_vals[f] is not None]

        # Candidate pool: every other playable track that has features.
        cand = conn.execute(
            f"SELECT id, spotify_uri, {', '.join(feats)} FROM tracks "
            f"WHERE feature_source IS NOT NULL AND spotify_uri LIKE 'spotify:track:%%' "
            f"AND id <> %s",
            (seed_id,),
        ).fetchall()

        if not usable_feats or not cand:
            return {"seedUri": uri, "hasFeatures": False, "tracks": []}

        col_index = {f: feats.index(f) + 2 for f in feats}  # position in `cand` rows
        # Per-feature range for normalization (across seed + candidates).
        ranges = {}
        for f in usable_feats:
            ci = col_index[f]
            col = [seed_vals[f]] + [row[ci] for row in cand if row[ci] is not None]
            lo, hi = min(col), max(col)
            ranges[f] = (lo, hi - lo if hi > lo else 1.0)

        scored = []
        for row in cand:
            cand_id = row[0]
            dist = 0.0
            usable = True
            for f in usable_feats:
                v = row[col_index[f]]
                if v is None:
                    usable = False
                    break
                _lo, span = ranges[f]
                d = (v - seed_vals[f]) / span
                dist += SIMILARITY_FEATURES[f] * d * d
            if usable:
                scored.append((dist, cand_id))
        scored.sort(key=lambda x: x[0])
        top_ids = [cid for _, cid in scored[:limit]]
        if not top_ids:
            return {"seedUri": uri, "hasFeatures": True, "tracks": []}

        # Fetch the full payload with the track id so we can restore distance order.
        rows = conn.execute(
            f"{_TRACK_SELECT}, t.id FROM tracks t WHERE t.id = ANY(%s)", (top_ids,)
        ).fetchall()
    order = {cid: n for n, cid in enumerate(top_ids)}
    rows.sort(key=lambda r: order.get(r[16], 1e9))
    return {"seedUri": uri, "hasFeatures": True, "tracks": [_track_payload(r[:16]) for r in rows]}


def duplicates() -> list[dict]:
    """Groups of tracks that share an ISRC (the same recording under different
    Spotify URIs), with the playlists each appears in. Only groups of 2+."""
    with _connect() as conn:
        isrcs = [
            r[0] for r in conn.execute(
                """SELECT isrc FROM tracks
                   WHERE isrc IS NOT NULL AND isrc <> '' AND spotify_uri LIKE 'spotify:track:%%'
                   GROUP BY isrc HAVING count(*) > 1
                   ORDER BY count(*) DESC, isrc"""
            ).fetchall()
        ]
        if not isrcs:
            return []
        rows = conn.execute(
            f"""{_TRACK_SELECT}, t.isrc,
                   (SELECT string_agg(p.name, ', ' ORDER BY p.name)
                      FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
                      WHERE pt.track_id = t.id) AS playlists
            FROM tracks t
            WHERE t.isrc = ANY(%s) AND t.spotify_uri LIKE 'spotify:track:%%'
            ORDER BY t.isrc, lower(t.title)""",
            (isrcs,),
        ).fetchall()
    groups: dict[str, dict] = {}
    for r in rows:
        isrc = r[16]
        track = _track_payload(r[:16])
        track["playlists"] = r[17] or ""
        groups.setdefault(isrc, {"isrc": isrc, "tracks": []})["tracks"].append(track)
    # Keep only real duplicates and order biggest-first.
    out = [g for g in groups.values() if len(g["tracks"]) > 1]
    out.sort(key=lambda g: len(g["tracks"]), reverse=True)
    return out


def library_health() -> dict:
    """At-a-glance coverage: features, artist countries, and source breakdown."""
    with _connect() as conn:
        total_tracks = conn.execute("SELECT count(*) FROM tracks").fetchone()[0]
        with_features = conn.execute(
            "SELECT count(*) FROM tracks WHERE feature_source IS NOT NULL"
        ).fetchone()[0]
        with_art = conn.execute(
            "SELECT count(*) FROM tracks WHERE album_art_url IS NOT NULL"
        ).fetchone()[0]
        total_artists = conn.execute("SELECT count(*) FROM artists").fetchone()[0]
        resolved_artists = conn.execute(
            "SELECT count(*) FROM artists WHERE country_code IS NOT NULL"
        ).fetchone()[0]
        sources = [
            {"label": r[0] or "unknown", "value": int(r[1])}
            for r in conn.execute(
                """SELECT coalesce(feature_source, 'none'), count(*) FROM tracks
                   GROUP BY feature_source ORDER BY count(*) DESC"""
            ).fetchall()
        ]
    return {
        "tracks": {"total": total_tracks, "withFeatures": with_features, "withArt": with_art},
        "artists": {"total": total_artists, "resolved": resolved_artists},
        "featureSources": sources,
    }


# --------------------------------------------------------------------------- #
# Saved filters (smart playlists)
# --------------------------------------------------------------------------- #
def list_saved_filters() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, rules, updated_at FROM saved_filters ORDER BY lower(name)"
        ).fetchall()
    return [{"id": r[0], "name": r[1], "rules": r[2], "updatedAt": r[3].isoformat()} for r in rows]


def save_filter(name: str, rules: dict) -> dict:
    import json as _json
    with _connect() as conn:
        row = conn.execute(
            "INSERT INTO saved_filters (name, rules) VALUES (%s, %s) RETURNING id",
            (name, _json.dumps(rules)),
        ).fetchone()
        conn.commit()
    return {"id": row[0], "name": name, "rules": rules}


def delete_filter(filter_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM saved_filters WHERE id = %s", (filter_id,))
        conn.commit()
        return cur.rowcount > 0
