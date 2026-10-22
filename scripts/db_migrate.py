#!/usr/bin/env python3
"""Apply the baseline schema and any pending migrations to the metadata DB.

A lightweight, dependency-free migration runner: it ensures db/schema.sql (the
idempotent baseline) is applied, then runs each db/migrations/NNNN_*.sql file
that has not been recorded yet, in filename order, recording every applied
version in a `schema_migrations` table. Safe to run repeatedly.

Usage:
    python scripts/db_migrate.py [--database-url URL]
"""

import argparse
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DEFAULT_URL = "postgresql://spotify:spotify@localhost:5432/spotify_meta"
SCHEMA_PATH = ROOT / "db" / "schema.sql"
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def resolve_url(cli_url: str | None) -> str:
    import os
    return cli_url or os.getenv("DATABASE_URL") or DEFAULT_URL


def _ensure_tracking(conn) -> set[str]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "  version TEXT PRIMARY KEY,"
        "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    )
    conn.commit()
    return {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}


def pending(applied: set[str]) -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql")) if MIGRATIONS_DIR.is_dir() else []
    return [f for f in files if f.stem not in applied]


def migrate(url: str) -> list[str]:
    """Apply baseline + pending migrations. Returns the versions newly applied."""
    import psycopg

    newly: list[str] = []
    with psycopg.connect(url) as conn:
        applied = _ensure_tracking(conn)
        # Baseline is idempotent (CREATE TABLE IF NOT EXISTS), so apply it every
        # run to guarantee the base tables exist before migrations touch them.
        conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.commit()

        for path in pending(applied):
            version = path.stem
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))
            conn.commit()
            newly.append(version)
            print(f"Applied migration: {version}")
    return newly


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply schema + pending migrations.")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit("Missing driver. Install with:  pip install 'psycopg[binary]'")
    if not SCHEMA_PATH.is_file():
        raise SystemExit(f"Schema file not found: {SCHEMA_PATH}")

    url = resolve_url(args.database_url)
    safe = urlunparse(urlparse(url)._replace(netloc=urlparse(url).hostname or ""))
    print(f"Target database: {urlparse(url).path.lstrip('/')} @ {safe}")

    try:
        newly = migrate(url)
    except Exception as exc:
        raise SystemExit(
            f"Migration failed: {exc}\n"
            "Is Postgres running and reachable at DATABASE_URL? "
            "To start one locally:  docker compose -f db/docker-compose.yml up -d"
        ) from exc

    print(f"{len(newly)} migration(s) applied." if newly else "Already up to date.")
    print("Done.")


if __name__ == "__main__":
    main()
