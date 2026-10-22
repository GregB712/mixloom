"""In-memory async job registry. Runs a script as a subprocess per job and
captures merged stdout/stderr line-by-line for live streaming over SSE."""

import subprocess
import sys
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from config import ROOT, SCRIPTS


def _now() -> str:
    return datetime.now(UTC).isoformat()


class Job:
    def __init__(self, job_type: str, args: list[str], stdin_text: str | None):
        self.id = uuid.uuid4().hex[:12]
        self.type = job_type
        self.args = args
        self.stdin_text = stdin_text
        self.status = "pending"  # pending | running | succeeded | failed
        self.returncode: int | None = None
        self.startedAt: str | None = None
        self.finishedAt: str | None = None
        self.lines: list[str] = []
        self._event = threading.Event()  # fires whenever a line is added or status changes

    def meta(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "status": self.status,
            "args": self.args,
            "returncode": self.returncode,
            "startedAt": self.startedAt,
            "finishedAt": self.finishedAt,
            "lineCount": len(self.lines),
        }

    def _append(self, line: str) -> None:
        self.lines.append(line)
        self._event.set()

    def _finish(self, status: str, returncode: int | None) -> None:
        self.status = status
        self.returncode = returncode
        self.finishedAt = _now()
        self._event.set()


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def list(self) -> list[dict]:
        return [j.meta() for j in sorted(
            self._jobs.values(), key=lambda j: j.startedAt or "", reverse=True
        )]

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def start(self, job_type: str, args: list[str], stdin_text: str | None = None) -> Job:
        if job_type not in SCRIPTS:
            raise ValueError(f"Unknown job type: {job_type}")
        job = Job(job_type, args, stdin_text)
        self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _run(self, job: Job) -> None:
        script = SCRIPTS[job.type]
        cmd = [sys.executable, "-u", str(ROOT / script), *job.args]
        job.status = "running"
        job.startedAt = _now()
        job._event.set()
        job._append("$ " + " ".join(_display(cmd)))
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env={**_env(), "PYTHONUNBUFFERED": "1"},
            )
        except OSError as exc:
            job._append(f"Failed to start process: {exc}")
            job._finish("failed", -1)
            return

        if proc.stdin is not None:
            try:
                if job.stdin_text:
                    proc.stdin.write(job.stdin_text)
                proc.stdin.close()
            except OSError:
                pass

        assert proc.stdout is not None
        for line in proc.stdout:
            job._append(line.rstrip("\n"))
        proc.wait()
        job._finish("succeeded" if proc.returncode == 0 else "failed", proc.returncode)


def _env() -> dict:
    import os
    return dict(os.environ)


def _display(cmd: list[str]) -> list[str]:
    # Show script basenames instead of absolute paths in the log header.
    return [Path(part).name if part.endswith(".py") else part for part in cmd]


registry = JobRegistry()
