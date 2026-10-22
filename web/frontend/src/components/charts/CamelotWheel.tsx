import type { CountItem } from "../../api/client";

// Camelot wheel: 12 clock positions, an inner ring for the A keys (minor) and an
// outer ring for the B keys (major). Each node is sized and shaded by how many
// tracks carry that key, so key distribution and the compatible-key clusters
// (same number / adjacent number / relative major-minor) are visible at a glance.
export function CamelotWheel({ items }: { items: CountItem[] }) {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.label.toUpperCase(), (counts.get(it.label.toUpperCase()) ?? 0) + it.value);
  const max = Math.max(1, ...counts.values());

  const size = 320;
  const c = size / 2;
  const outer = 128; // B ring radius
  const inner = 84; // A ring radius

  const node = (n: number, letter: "A" | "B", ringR: number) => {
    const code = `${n}${letter}`;
    const value = counts.get(code) ?? 0;
    // 12 at top, clockwise.
    const angle = ((n % 12) / 12) * 2 * Math.PI - Math.PI / 2;
    const x = c + ringR * Math.cos(angle);
    const y = c + ringR * Math.sin(angle);
    const r = 11 + (value / max) * 11;
    const opacity = value === 0 ? 0.12 : 0.35 + (value / max) * 0.65;
    return (
      <g key={code}>
        <title>{`${code}: ${value} track${value === 1 ? "" : "s"}`}</title>
        <circle cx={x} cy={y} r={r} fill="var(--brand)" fillOpacity={opacity} stroke="var(--border)" />
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight={700} fill="var(--text)">
          {code}
        </text>
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" height={size} role="img" aria-label="Camelot wheel of key distribution">
      <circle cx={c} cy={c} r={outer + 16} fill="none" stroke="var(--border)" strokeDasharray="2 4" />
      {Array.from({ length: 12 }, (_, i) => node(i + 1, "B", outer))}
      {Array.from({ length: 12 }, (_, i) => node(i + 1, "A", inner))}
      <text x={c} y={c} textAnchor="middle" dominantBaseline="central" fontSize="11" fill="var(--text-faint)">
        A·B
      </text>
    </svg>
  );
}
