"""Unit tests for the Postgres query helpers in db.py."""

import db


# -------- pure helpers (no DB) --------------------------------------------- #
def test_num_rounds_and_passes_none():
    assert db._num(None) is None
    assert db._num(0.123456) == 0.1235


def test_histogram_handles_empty_and_constant():
    assert db._histogram([]) is None
    assert db._histogram([None, None]) is None
    const = db._histogram([5, 5, 5])
    assert const == {"bins": [{"x0": 5.0, "x1": 5.0, "count": 3}]}


def test_histogram_bins_sum_to_count():
    hist = db._histogram([1, 2, 3, 4, 5, 6, 7, 8], bins=4)
    assert hist is not None
    assert sum(b["count"] for b in hist["bins"]) == 8


# -------- DB-backed helpers ------------------------------------------------ #
def test_list_playlists_shapes(test_db):
    rows = db.list_playlists()
    names = {r["name"] for r in rows}
    assert {"Exported", "Curated"} <= names
    exported = next(r for r in rows if r["name"] == "Exported")
    assert exported["trackCount"] == 3
    assert "spotifyPlaylistId" in exported
    assert exported["curated"] is False


def test_playlist_tracks_includes_album_art(test_db):
    exported = next(r for r in db.list_playlists() if r["name"] == "Exported")
    tracks = db.playlist_tracks(exported["id"])
    assert tracks and len(tracks) == 3
    assert "albumArt" in tracks[0]
    assert tracks[0]["uri"].startswith("spotify:track:")


def test_playlist_tracks_missing_returns_none(test_db):
    assert db.playlist_tracks(999999) is None


def test_find_similar_with_and_without_features(test_db):
    seed = db.find_similar("spotify:track:aaa", 10)
    assert seed is not None
    assert seed["hasFeatures"] is True
    uris = {t["uri"] for t in seed["tracks"]}
    assert "spotify:track:aaa" not in uris  # seed excluded
    assert "spotify:track:bbb" in uris  # closest by tempo/energy

    # A track without features can't be a seed for similarity.
    none_feat = db.find_similar("spotify:track:ddd", 10)
    assert none_feat is not None
    assert none_feat["hasFeatures"] is False
    assert none_feat["tracks"] == []

    assert db.find_similar("spotify:track:nope", 10) is None


def test_duplicates_groups_by_isrc(test_db):
    groups = db.duplicates()
    assert len(groups) == 1
    g = groups[0]
    assert g["isrc"] == "ISRCDUP01"
    assert {t["uri"] for t in g["tracks"]} == {"spotify:track:aaa", "spotify:track:bbb"}
    # Playlist membership is annotated.
    assert any("Exported" in (t["playlists"] or "") for t in g["tracks"])


def test_library_health_counts(test_db):
    h = db.library_health()
    assert h["tracks"]["total"] == 4
    assert h["tracks"]["withFeatures"] == 3
    assert h["tracks"]["withArt"] == 2
    assert h["artists"]["total"] == 3
    assert h["artists"]["resolved"] == 2
    labels = {s["label"] for s in h["featureSources"]}
    assert "essentia" in labels


def test_saved_filters_roundtrip(test_db):
    created = db.save_filter("Greek 124-129", {"greek": "greek", "ranges": {"bpm": {"min": "124", "max": "129"}}})
    assert created["id"]
    listed = db.list_saved_filters()
    assert any(f["name"] == "Greek 124-129" for f in listed)
    assert db.delete_filter(created["id"]) is True
    assert db.delete_filter(created["id"]) is False  # already gone


def test_save_and_update_curated(test_db):
    saved = db.save_curated("My Build", ["spotify:track:aaa", "spotify:track:ccc"])
    assert saved is not None
    assert saved["count"] == 2
    pid = saved["playlistId"]

    # Reorder / shrink via update.
    updated = db.update_playlist_tracks(pid, ["spotify:track:ccc"])
    assert updated is not None and updated["count"] == 1

    # Updating a non-curated (exported) playlist is refused.
    exported = next(r for r in db.list_playlists() if r["name"] == "Exported")
    assert db.update_playlist_tracks(exported["id"], ["spotify:track:aaa"]) is None


def test_set_spotify_playlist_id(test_db):
    saved = db.save_curated("Push Me", ["spotify:track:aaa"])
    db.set_spotify_playlist_id(saved["playlistId"], "SPNEW99")
    row = next(r for r in db.list_playlists() if r["id"] == saved["playlistId"])
    assert row["spotifyPlaylistId"] == "SPNEW99"


def test_delete_playlist_cleans_orphans(test_db):
    # ddd is seeded into no playlist, so it is an orphan the cleanup should sweep.
    assert "spotify:track:ddd" in db.tracks_by_uri(["spotify:track:ddd"])

    saved = db.save_curated("ToDelete", ["spotify:track:aaa", "spotify:track:bbb"])
    pid = saved["playlistId"]
    res = db.delete_playlist(pid)
    assert res is not None and res["name"] == "ToDelete"
    assert not any(p["id"] == pid for p in db.list_playlists())

    # Shared tracks (still in Exported) survive; the orphaned ddd is removed.
    assert "spotify:track:aaa" in db.tracks_by_uri(["spotify:track:aaa"])
    assert db.tracks_by_uri(["spotify:track:ddd"]) == {}
    assert res["removedTracks"] >= 1

    assert db.delete_playlist(999999) is None


def test_playlist_mirror_and_tracks_by_uri(test_db):
    exported = next(r for r in db.list_playlists() if r["name"] == "Exported")
    mirror = db.playlist_mirror(exported["id"])
    assert mirror is not None
    assert mirror["spotifyId"] == "SP123"
    assert len(mirror["uris"]) == 3
    lookup = db.tracks_by_uri(["spotify:track:aaa"])
    assert lookup["spotify:track:aaa"]["title"] == "Alpha"


# -------- metadata editor -------------------------------------------------- #
def _insert_bare_track(uri: str, title: str) -> int:
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tracks (spotify_uri, title, feature_source) VALUES (%s,%s,NULL) RETURNING id",
            (uri, title),
        )
        tid = cur.fetchone()[0]
        conn.commit()
    return tid


def _delete_track(tid: int) -> None:
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM tracks WHERE id = %s", (tid,))
        conn.commit()


def test_list_tracks_detail_and_missing_filter(test_db):
    tid = _insert_bare_track("spotify:track:meta1", "Zeta Meta")
    try:
        page = db.list_tracks_detail(None, False, "zeta meta", 0, 50)
        assert page is not None
        hit = next(t for t in page["tracks"] if t["id"] == tid)
        # A bare track is missing every core field and exposes all editable ones.
        assert set(hit["missing"]) == set(db.CORE_FIELDS)
        assert "bpm" in hit["fields"] and hit["fields"]["bpm"] is None

        # It appears under the missing-only filter.
        miss = db.list_tracks_detail(None, True, "zeta meta", 0, 50)
        assert any(t["id"] == tid for t in miss["tracks"])
    finally:
        _delete_track(tid)


def test_update_track_metadata_marks_manual_source(test_db):
    tid = _insert_bare_track("spotify:track:meta2", "Eta Meta")
    try:
        res = db.update_track_metadata(tid, {"bpm": "128", "genre": "house", "nope": "x"})
        assert res is not None
        assert res["fields"]["bpm"] == 128.0
        assert res["fields"]["genre"] == "house"
        # Filling features on an unsourced track records a manual source.
        assert res["featureSource"] == "manual"
        assert "bpm" not in res["missing"] and "genre" not in res["missing"]

        # Empty string clears a field back to NULL.
        cleared = db.update_track_metadata(tid, {"genre": ""})
        assert cleared["fields"]["genre"] is None
        assert "genre" in cleared["missing"]

        assert db.update_track_metadata(99999999, {"bpm": "120"}) is None
    finally:
        _delete_track(tid)


def test_list_tracks_detail_playlist_scope(test_db):
    exported = next(r for r in db.list_playlists() if r["name"] == "Exported")
    page = db.list_tracks_detail(exported["id"], False, "", 0, 50)
    assert page is not None
    assert page["total"] == len(db.playlist_tracks(exported["id"]))
    assert db.list_tracks_detail(999999, False, "", 0, 50) is None


def test_track_field_options(test_db):
    opts = db.track_field_options()
    assert set(opts) == {"genre", "mood"}
    assert isinstance(opts["genre"], list) and isinstance(opts["mood"], list)
