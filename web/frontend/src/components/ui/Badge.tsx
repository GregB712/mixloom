import type { ReactNode } from "react";

type Tone = "default" | "ok" | "warn" | "danger" | "accent";

export function Badge({ tone = "default", children }: { tone?: Tone; children: ReactNode }) {
  const cls = tone === "default" ? "badge" : `badge badge--${tone}`;
  return <span className={cls}>{children}</span>;
}
