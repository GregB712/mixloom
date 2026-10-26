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
