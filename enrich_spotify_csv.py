#!/usr/bin/env python3
"""Add FreqBlog audio-feature metadata to a Spotify-exported CSV.

Requires FREQBLOG_API_KEY in .env. The source file is never overwritten.
"""

import csv
import io
import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

API_URL = "https://api.freqblog.com/bulk-csv"
API_KEY = os.getenv("FREQBLOG_API_KEY", "").strip()
DEFAULT_INPUT = Path("spotify_exports/merged_playlists.csv")
BATCH_SIZE = 500
MAX_PROCESSING_RETRIES = 2
RETRY_DELAY_SECONDS = 35
TIMEOUT_SECONDS = 90


def primary_artist(row: dict) -> str:
    """Use the exact JSON artist list where available, otherwise fall back."""
    raw_json = (row.get("artist_names_json") or "").strip()
    if raw_json:
        try:
            names = json.loads(raw_json)
            if isinstance(names, list):
                for name in names:
                    if isinstance(name, str) and name.strip():
                        return name.strip()
        except json.JSONDecodeError:
            pass

    artist = (row.get("artist") or "").strip()
    if artist:
        return artist

    artists = (row.get("artists") or "").strip()
    return artists.split(", ", 1)[0].strip()


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            raise ValueError("Input CSV has no header.")
        fields = list(reader.fieldnames)
        rows = list(reader)

    if "title" not in fields:
        raise ValueError("Input CSV must contain a 'title' column.")
    if not ("artists" in fields or "artist" in fields or "artist_names_json" in fields):
        raise ValueError("Input CSV must contain 'artists', 'artist', or 'artist_names_json'.")
    return fields, rows


def serialize_csv(rows: list[dict], fields: list[str]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8-sig")


def call_bulk_csv(rows: list[dict], fields: list[str]) -> tuple[list[str], list[dict], dict]:
    upload_rows = []
    for source in rows:
        row = dict(source)
        # The service matches on artist + title. Put the primary credited artist
        # in the field it expects while keeping the original 'artists' field.
        row["artist"] = primary_artist(source)
        upload_rows.append(row)

    upload_fields = list(fields)
    if "artist" not in upload_fields:
        upload_fields.append("artist")

    response = requests.post(
        API_URL,
        headers={"X-Api-Key": API_KEY},
        files={"file": ("tracks.csv", serialize_csv(upload_rows, upload_fields), "text/csv")},
        timeout=TIMEOUT_SECONDS,
    )

    if not response.ok:
        raise RuntimeError(
            f"FreqBlog returned HTTP {response.status_code}: {response.text[:1200]}"
        )

    text = response.content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise RuntimeError("FreqBlog returned a CSV without headers.")

    results = list(reader)
    if len(results) != len(rows):
        raise RuntimeError(
            f"FreqBlog returned {len(results)} rows for {len(rows)} submitted rows."
        )

    headers = dict(response.headers)
    return list(reader.fieldnames or []), results, headers


def is_processing(row: dict) -> bool:
    found = (row.get("found") or "").strip().lower()
    status = (row.get("backfill_status") or "").strip().lower()
    return found == "processing" or status in {"processing", "queued"}


def enrich_batch(rows: list[dict], input_fields: list[str], batch_number: int, total_batches: int):
    fields, result_rows, headers = call_bulk_csv(rows, input_fields)
    for attempt in range(1, MAX_PROCESSING_RETRIES + 1):
        pending_indexes = [i for i, row in enumerate(result_rows) if is_processing(row)]
        if not pending_indexes:
            break

        print(
            f"  Batch {batch_number}/{total_batches}: {len(pending_indexes)} pending; "
            f"retry {attempt}/{MAX_PROCESSING_RETRIES} in {RETRY_DELAY_SECONDS}s."
        )
        time.sleep(RETRY_DELAY_SECONDS)

        pending_input = [rows[i] for i in pending_indexes]
        retry_fields, retry_rows, retry_headers = call_bulk_csv(pending_input, input_fields)
        for field in retry_fields:
            if field not in fields:
                fields.append(field)
        for index, update in zip(pending_indexes, retry_rows):
            # Retain prior non-empty values if the retry returns an empty cell.
            for key, value in update.items():
                if value not in (None, "") or key not in result_rows[index]:
                    result_rows[index][key] = value
        headers.update(retry_headers)

    still_processing = sum(is_processing(row) for row in result_rows)
    if still_processing:
        print(
            f"  Warning: {still_processing} rows remain marked as processing. "
            "Their feature fields may be blank; they remain in the output."
        )
    return fields, result_rows, headers


def main() -> None:
    if not API_KEY:
        raise SystemExit("FREQBLOG_API_KEY is missing from your .env file.")

    input_path = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_INPUT
    if not input_path.is_file():
        raise SystemExit(f"Input CSV not found: {input_path}")

    try:
        input_fields, rows = read_csv(input_path)
    except (OSError, csv.Error, ValueError) as exc:
        raise SystemExit(f"Could not read input CSV: {exc}") from exc

    if not rows:
        raise SystemExit("Input CSV contains no tracks.")

    output_path = input_path.with_name(f"{input_path.stem}_enriched.csv")
    total_batches = (len(rows) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"Input: {input_path}")
    print(f"Tracks: {len(rows)}")
    print(f"Output: {output_path}")

    all_rows = []
    api_fields = []
    added_artist_helper = "artist" not in input_fields

    for start in range(0, len(rows), BATCH_SIZE):
        batch_number = start // BATCH_SIZE + 1
        batch = rows[start:start + BATCH_SIZE]
        print(f"\nProcessing batch {batch_number}/{total_batches} ({len(batch)} tracks)")

        try:
            response_fields, enriched_rows, headers = enrich_batch(
                batch, input_fields, batch_number, total_batches
            )
        except (requests.RequestException, RuntimeError) as exc:
            raise SystemExit(
                f"Batch {batch_number} failed: {exc}\n"
                "The original CSV is unchanged. Retry the command after checking the API key/quota."
            ) from exc

        all_rows.extend(enriched_rows)
        for field in response_fields:
            if field not in api_fields:
                api_fields.append(field)

        processed = headers.get("X-Bulk-Rows-Processed", "?")
        pending = headers.get("X-Bulk-Rows-Pending", "?")
        print(f"  API report: processed={processed}, pending={pending}")

    # Retain source fields first, then append fields introduced by the API.
    output_fields = list(input_fields)
    for field in api_fields:
        if field not in output_fields:
            output_fields.append(field)

    # Keep an artist helper only if it existed in the original CSV.
    if added_artist_helper:
        output_fields = [field for field in output_fields if field != "artist"]
        for row in all_rows:
            row.pop("artist", None)

    with output_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=output_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(all_rows)

    pending_count = sum(is_processing(row) for row in all_rows)
    not_found_count = sum((row.get("found") or "").strip().lower() == "false" for row in all_rows)
    print("\nFinished.")
    print(f"Rows exported: {len(all_rows)}")
    print(f"Rows still processing: {pending_count}")
    print(f"Rows marked not found: {not_found_count}")
    print(f"Saved to: {output_path.resolve()}")


if __name__ == "__main__":
    main()
