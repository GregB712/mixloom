import { useEffect, useRef } from "react";
import type { JobStatus } from "../../api/client";
import { StatusPill } from "./StatusPill";

export function LogPanel({
  lines,
  status,
  autoScroll = true,
}: {
  lines: string[];
  status: JobStatus | null;
  autoScroll?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoScroll]);

  return (
    <div className="logpanel">
      <div className="logpanel__bar">
        {status ? <StatusPill status={status} /> : <span className="pill pill--pending"><span className="pill__dot" />Starting</span>}
        <span className="small faint">{lines.length} lines</span>
      </div>
      <pre className="logpanel__out" ref={ref} aria-live="polite">
        {lines.length === 0
          ? "Waiting for output…"
          : lines.map((line, i) => (
              <div key={i} className={line.startsWith("$ ") ? "cmd" : undefined}>
                {line || " "}
              </div>
            ))}
      </pre>
    </div>
  );
}
