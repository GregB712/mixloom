import { useEffect, useRef, useState } from "react";
import type { JobStatus } from "../api/client";

export type JobStreamState = {
  lines: string[];
  status: JobStatus | null;
  returncode: number | null;
  done: boolean;
};

// Subscribes to a job's SSE stream and accumulates its log lines + status.
export function useJobStream(jobId: string | null, onDone?: (ok: boolean) => void) {
  const [state, setState] = useState<JobStreamState>({
    lines: [],
    status: null,
    returncode: null,
    done: false,
  });
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!jobId) return;
    setState({ lines: [], status: null, returncode: null, done: false });
    const source = new EventSource(`/api/jobs/${jobId}/stream`);

    source.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.kind === "log") {
        setState((s) => ({ ...s, lines: [...s.lines, ...msg.lines] }));
      } else if (msg.kind === "status") {
        setState((s) => ({ ...s, status: msg.status, returncode: msg.returncode }));
      } else if (msg.kind === "done") {
        setState((s) => ({ ...s, status: msg.status, returncode: msg.returncode, done: true }));
        source.close();
        doneRef.current?.(msg.status === "succeeded");
      }
    };

    source.onerror = () => {
      // The browser auto-reconnects; close once the job has already finished.
      setState((s) => {
        if (s.done) source.close();
        return s;
      });
    };

    return () => source.close();
  }, [jobId]);

  return state;
}
