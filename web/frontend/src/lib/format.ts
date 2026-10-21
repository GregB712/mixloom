export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function relativeTime(mtimeSeconds: number): string {
  const diff = Date.now() / 1000 - mtimeSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Stable chart colors drawn from the CSS token palette.
export const CHART_COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
export function chartColor(i: number): string {
  return `var(${CHART_COLORS[i % CHART_COLORS.length]})`;
}
