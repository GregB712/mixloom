#!/usr/bin/env python3
"""Create the metadata database (if missing) and apply db/schema.sql.

Idempotent: run it as many times as you like. Reads DATABASE_URL from .env or
the environment (default: postgresql://spotify:spotify@localhost:5432/spotify_meta).

If you start Postgres via db/docker-compose.yml, the schema is already applied
on first boot and this script simply confirms the tables exist.

Usage:
    python scripts/db_init.py [--database-url URL]
"""

import argparse
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DEFAULT_URL = "postgresql://spotify:spotify@localhost:5432/spotify_meta"
SCHEMA_PATH = ROOT / "db" / "schema.sql"


def resolve_url(cli_url: str | None) -> str:
    import os
    return cli_url or os.getenv("DATABASE_URL") or DEFAULT_URL


def ensure_database(url: str) -> bool:
    """Connect to the maintenance DB and CREATE DATABASE if the target is
    missing. Returns True if it created it, False if it already existed."""
    import psycopg

    parsed = urlparse(url)
    target_db = parsed.path.lstrip("/")
    if not target_db:
        raise SystemExit("DATABASE_URL has no database name.")

    admin_url = urlunparse(parsed._replace(path="/postgres"))
    with psycopg.connect(admin_url, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (target_db,)
        ).fetchone()
        if exists:
            return False
        # Identifier can't be parameterised; it comes from our own URL.
        conn.execute(f'CREATE DATABASE "{target_db}"')
        return True


def apply_schema(url: str) -> None:
    import psycopg

    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with psycopg.connect(url) as conn:
        conn.execute(sql)
        conn.commit()
        tables = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_name"
        ).fetchall()
    print("Tables present:", ", ".join(t[0] for t in tables) or "(none)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create and initialise the metadata DB.")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()

    try:
        import psycopg  # noqa: F401
    except ImportError:
        raise SystemExit(
            "Missing driver. Install with:  pip install 'psycopg[binary]'"
        )
    if not SCHEMA_PATH.is_file():
        raise SystemExit(f"Schema file not found: {SCHEMA_PATH}")

    url = resolve_url(args.database_url)
    # Don't print credentials.
    safe = urlunparse(urlparse(url)._replace(netloc=urlparse(url).hostname or ""))
    print(f"Target database: {urlparse(url).path.lstrip('/')} @ {safe}")

    try:
        created = ensure_database(url)
        print("Created database." if created else "Database already exists.")
        apply_schema(url)
    except Exception as exc:  # psycopg.OperationalError etc.
        raise SystemExit(
            f"Database setup failed: {exc}\n"
            "Is Postgres running and reachable at DATABASE_URL? "
            "To start one locally:  docker compose -f db/docker-compose.yml up -d"
        ) from exc

    print("Done.")


if __name__ == "__main__":
    main()
