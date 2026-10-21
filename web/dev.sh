#!/usr/bin/env bash
# Start the FastAPI backend and the Vite frontend together for local development.
# Stop both with Ctrl+C.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV_PY="$ROOT/.venv/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
  echo "Project venv not found at $VENV_PY. Create it and install requirements first." >&2
  exit 1
fi

# Derive the backend host/port from SPOTIPY_REDIRECT_URI so the callback matches
# what is registered in the Spotify app (default http://127.0.0.1:8888/callback).
read -r HOST PORT < <("$VENV_PY" - "$ROOT" <<'PY'
import os, sys
from urllib.parse import urlparse
sys.path.insert(0, sys.argv[1])
from dotenv import load_dotenv
load_dotenv(os.path.join(sys.argv[1], ".env"))
u = urlparse(os.getenv("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback"))
print(u.hostname or "127.0.0.1", u.port or 8888)
PY
)

# Check the Postgres metadata DB is reachable; the backend serves all data from
# it. Warn (don't abort) so frontend-only work still works.
"$VENV_PY" - "$ROOT" <<'PY' || true
import os, sys
from urllib.parse import urlparse
sys.path.insert(0, sys.argv[1])
from dotenv import load_dotenv
load_dotenv(os.path.join(sys.argv[1], ".env"))
url = os.getenv("DATABASE_URL", "postgresql://spotify:spotify@localhost:5432/spotify_meta")
p = urlparse(url)
safe = f"{p.hostname or 'localhost'}:{p.port or 5432}{p.path}"
try:
    import psycopg
    psycopg.connect(url).close()
    print(f"Database: reachable ({safe})")
except Exception as exc:
    print(f"Database: NOT reachable ({safe}) - {exc.__class__.__name__}", file=sys.stderr)
    print("  Start it with:  docker compose -f db/docker-compose.yml up -d", file=sys.stderr)
    print("  (the app will show backend errors until the DB is up)", file=sys.stderr)
PY

echo "Backend:  http://$HOST:$PORT"
echo "Frontend: http://localhost:5173"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"$VENV_PY" -m uvicorn main:app --app-dir "$HERE/backend" --host "$HOST" --port "$PORT" --reload &

cd "$HERE/frontend"
if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies…"
  npm install
fi
npm run dev -- --host &

wait
