import type { JobStatus } from "../../api/client";

const LABELS: Record<JobStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span className={`pill pill--${status}`}>
      <span className="pill__dot" aria-hidden />
      {LABELS[status]}
    </span>
  );
}
