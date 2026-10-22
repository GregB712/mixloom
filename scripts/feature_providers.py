"""Pluggable audio-feature / tag enrichment providers.

Each provider turns a list of tracks (id, title, artist, isrc, spotify_uri) into
feature updates, yielding ``(track_id, feature_dict)`` for the tracks it could
enrich. Keeping this behind a small interface means the pipeline no longer
depends on any single source: if one changes or disappears, another can fill in
(the same risk that shaped the FreqBlog-or-local design).

Providers:
  - ``freqblog``  — audio features (bpm/energy/key/…) from the FreqBlog bulk-CSV API.
  - ``lastfm``    — genre/mood tags from Last.fm top tags (no audio features).

Register a new source by adding a class and listing it in ``PROVIDERS``.
"""

from __future__ import annotations

import csv
import io
import os
import time
from collections.abc import Callable, Iterator
from typing import Protocol

import requests

import dbutil

Emit = Callable[[str], None]
FeatureUpdate = tuple[int, dict]


class FeatureProvider(Protocol):
    name: str

    def available(self) -> tuple[bool, str]:
        """(usable, reason-if-not). Checks config such as API keys."""
        ...

    def enrich(self, tracks: list[dict], emit: Emit) -> Iterator[FeatureUpdate]:
        """Yield (track_id, feature_dict) for each track this provider enriched."""
        ...


# --------------------------------------------------------------------------- #
# FreqBlog — bulk audio features
# --------------------------------------------------------------------------- #
class FreqBlogProvider:
    name = "freqblog"

    API_URL = "https://api.freqblog.com/bulk-csv"
    BATCH_SIZE = 500
    MAX_PROCESSING_RETRIES = 2
    RETRY_DELAY_SECONDS = 35
    TIMEOUT_SECONDS = 90
    UPLOAD_FIELDS = ["title", "artist", "isrc", "spotify_uri"]

    def __init__(self) -> None:
        self.api_key = os.getenv("FREQBLOG_API_KEY", "").strip()

    def available(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "FREQBLOG_API_KEY is missing from your .env file."
        return True, ""

    def _serialize(self, rows: list[dict]) -> bytes:
        buf = io.StringIO(newline="")
        writer = csv.DictWriter(buf, fieldnames=self.UPLOAD_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode("utf-8-sig")

    def _call(self, rows: list[dict]) -> list[dict]:
        response = requests.post(
            self.API_URL,
            headers={"X-Api-Key": self.api_key},
            files={"file": ("tracks.csv", self._serialize(rows), "text/csv")},
            timeout=self.TIMEOUT_SECONDS,
        )
        if not response.ok:
            raise RuntimeError(f"FreqBlog returned HTTP {response.status_code}: {response.text[:800]}")
        text = response.content.decode("utf-8-sig")
        results = list(csv.DictReader(io.StringIO(text)))
        if len(results) != len(rows):
            raise RuntimeError(f"FreqBlog returned {len(results)} rows for {len(rows)} submitted.")
        return results

    @staticmethod
    def _is_processing(row: dict) -> bool:
        found = (row.get("found") or "").strip().lower()
        status = (row.get("backfill_status") or "").strip().lower()
        return found == "processing" or status in {"processing", "queued"}

    def _enrich_batch(self, rows: list[dict], n: int, total: int, emit: Emit) -> list[dict]:
        results = self._call(rows)
        for attempt in range(1, self.MAX_PROCESSING_RETRIES + 1):
            pending = [i for i, r in enumerate(results) if self._is_processing(r)]
            if not pending:
                break
            emit(f"  Batch {n}/{total}: {len(pending)} pending; retry {attempt} in {self.RETRY_DELAY_SECONDS}s.")
            time.sleep(self.RETRY_DELAY_SECONDS)
            retry = self._call([rows[i] for i in pending])
            for idx, update in zip(pending, retry):
                for k, v in update.items():
                    if v not in (None, "") or k not in results[idx]:
                        results[idx][k] = v
        return results

    def enrich(self, tracks: list[dict], emit: Emit) -> Iterator[FeatureUpdate]:
        total_batches = (len(tracks) + self.BATCH_SIZE - 1) // self.BATCH_SIZE
        for start in range(0, len(tracks), self.BATCH_SIZE):
            n = start // self.BATCH_SIZE + 1
            batch = tracks[start:start + self.BATCH_SIZE]
            emit(f"\nProcessing batch {n}/{total_batches} ({len(batch)} tracks)")
            results = self._enrich_batch(batch, n, total_batches, emit)
            for track, result in zip(batch, results):
                if self._is_processing(result) or (result.get("found") or "").lower() == "false":
                    continue
                feats = {c: dbutil.coerce_feature(c, result.get(c)) for c in dbutil.FEATURE_COLUMNS}
                if feats.get("bpm") is None and feats.get("energy") is None:
                    continue  # nothing usable came back
                feats["feature_source"] = feats.get("feature_source") or "freqblog"
                yield track["id"], feats


# --------------------------------------------------------------------------- #
# Last.fm — genre / mood tags (no audio features)
# --------------------------------------------------------------------------- #
class LastfmTagProvider:
    name = "lastfm"

    API_URL = "https://ws.audioscrobbler.com/2.0/"
    TIMEOUT_SECONDS = 20
    SLEEP_SECONDS = 0.25  # be polite to the API

    def __init__(self) -> None:
        self.api_key = os.getenv("LASTFM_API_KEY", "").strip()

    def available(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "LASTFM_API_KEY is missing from your .env file."
        return True, ""

    def _top_tags(self, artist: str, title: str) -> list[str]:
        params = {
            "method": "track.gettoptags",
            "artist": artist,
            "track": title,
            "api_key": self.api_key,
            "format": "json",
            "autocorrect": 1,
        }
        resp = requests.get(self.API_URL, params=params, timeout=self.TIMEOUT_SECONDS)
        if not resp.ok:
            return []
        data = resp.json()
        tags = (data.get("toptags") or {}).get("tag") or []
        return [t.get("name", "").strip() for t in tags if t.get("name")]

    def enrich(self, tracks: list[dict], emit: Emit) -> Iterator[FeatureUpdate]:
        for i, track in enumerate(tracks, start=1):
            if not track.get("artist") or not track.get("title"):
                continue
            try:
                tags = self._top_tags(track["artist"], track["title"])
            except requests.RequestException:
                tags = []
            if i % 25 == 0:
                emit(f"  Queried {i}/{len(tracks)} tracks on Last.fm")
            time.sleep(self.SLEEP_SECONDS)
            if not tags:
                continue
            # First tag as genre; a second distinct tag as a coarse mood hint.
            feats = {"genre": tags[0], "feature_source": "lastfm"}
            if len(tags) > 1:
                feats["mood"] = tags[1]
            yield track["id"], feats


PROVIDERS: dict[str, type] = {
    FreqBlogProvider.name: FreqBlogProvider,
    LastfmTagProvider.name: LastfmTagProvider,
}


def get_provider(name: str) -> FeatureProvider:
    if name not in PROVIDERS:
        raise SystemExit(f"Unknown provider '{name}'. Available: {', '.join(PROVIDERS)}")
    return PROVIDERS[name]()  # type: ignore[return-value]
