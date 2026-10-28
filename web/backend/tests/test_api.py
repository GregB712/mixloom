"""API smoke tests against the FastAPI app with a throwaway database."""


def test_status_ok(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    assert "env" in r.json()


def test_playlists_endpoint(client):
    r = client.get("/api/playlists")
    assert r.status_code == 200
    names = {p["name"] for p in r.json()}
    assert {"Exported", "Curated"} <= names


def test_library_health_endpoint(client):
    r = client.get("/api/library-health")
    assert r.status_code == 200
    body = r.json()
    assert body["tracks"]["total"] == 4


def test_duplicates_endpoint(client):
    r = client.get("/api/duplicates")
    assert r.status_code == 200
    assert len(r.json()) == 1


def test_similar_endpoint(client):
    r = client.get("/api/tracks/similar", params={"uri": "spotify:track:aaa", "limit": 5})
    assert r.status_code == 200
    assert r.json()["hasFeatures"] is True

    missing = client.get("/api/tracks/similar", params={"uri": "spotify:track:nope"})
    assert missing.status_code == 404


def test_saved_filters_crud_endpoint(client):
    created = client.post("/api/saved-filters", json={"name": "Test", "rules": {"greek": "greek"}})
    assert created.status_code == 200
    fid = created.json()["id"]
    assert any(f["id"] == fid for f in client.get("/api/saved-filters").json())
    assert client.delete(f"/api/saved-filters/{fid}").status_code == 200
    assert client.delete(f"/api/saved-filters/{fid}").status_code == 404


def test_delete_missing_playlist_404(client):
    # Deleting a nonexistent playlist 404s and touches no data (so the db-level
    # orphan-sweep test, which runs later against the shared DB, is unaffected).
    assert client.delete("/api/playlists/999999").status_code == 404


def test_curate_save_endpoint(client):
    r = client.post("/api/curate/save", json={"name": "Via API", "uris": ["spotify:track:aaa"]})
    assert r.status_code == 200
    assert r.json()["count"] == 1

    bad = client.post("/api/curate/save", json={"name": "", "uris": ["spotify:track:aaa"]})
    assert bad.status_code == 400


def test_tracks_list_endpoint(client):
    r = client.get("/api/tracks", params={"q": "alpha", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    t = next(x for x in body["tracks"] if x["title"] == "Alpha")
    assert "fields" in t and "missing" in t

    assert client.get("/api/tracks", params={"missing": "true"}).status_code == 200
    assert client.get("/api/tracks", params={"playlistId": 999999}).status_code == 404


def test_track_update_endpoint(client):
    t = next(
        x for x in client.get("/api/tracks", params={"q": "alpha"}).json()["tracks"]
        if x["title"] == "Alpha"
    )
    tid, orig_genre = t["id"], t["fields"].get("genre")

    r = client.put(f"/api/tracks/{tid}", json={"fields": {"genre": "testgenre"}})
    assert r.status_code == 200
    assert r.json()["fields"]["genre"] == "testgenre"

    # Revert so later count-based tests see the seed unchanged.
    client.put(f"/api/tracks/{tid}", json={"fields": {"genre": orig_genre or ""}})

    assert client.put("/api/tracks/999999", json={"fields": {"bpm": "120"}}).status_code == 404


def test_track_field_options_endpoint(client):
    r = client.get("/api/tracks/field-options")
    assert r.status_code == 200
    body = r.json()
    assert "genre" in body and "mood" in body


def test_track_delete_endpoint(client):
    import db
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tracks (spotify_uri, title, feature_source) "
            "VALUES ('spotify:track:apidel', 'API Del', NULL) RETURNING id"
        )
        tid = cur.fetchone()[0]
        conn.commit()
    r = client.delete(f"/api/tracks/{tid}")
    assert r.status_code == 200 and r.json()["trackId"] == tid
    assert client.delete(f"/api/tracks/{tid}").status_code == 404


def test_tracks_orphan_param(client):
    r = client.get("/api/tracks", params={"orphan": "true", "limit": 200})
    assert r.status_code == 200
    assert "spotify:track:ddd" in {t["uri"] for t in r.json()["tracks"]}


def test_tracks_import_endpoint(client):
    import json

    import db
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tracks (spotify_uri, title, feature_source) "
            "VALUES ('spotify:track:impapi', 'Imp API', NULL) RETURNING id"
        )
        tid = cur.fetchone()[0]
        conn.commit()
    try:
        r = client.post("/api/tracks/import", json={
            "filename": "x.json",
            "content": json.dumps([{"id": tid, "bpm": "128", "mood": "happy"}]),
        })
        assert r.status_code == 200 and r.json()["updated"] == 1

        r2 = client.post("/api/tracks/import", json={"filename": "x.csv", "content": f"id,genre\n{tid},techno\n"})
        assert r2.status_code == 200 and r2.json()["updated"] == 1

        bad = client.post("/api/tracks/import", json={"filename": "x.json", "content": "not json"})
        assert bad.status_code == 400
    finally:
        with db._connect() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM tracks WHERE id = %s", (tid,))
            conn.commit()
