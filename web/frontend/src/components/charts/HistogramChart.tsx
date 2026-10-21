import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Histogram } from "../../api/client";

// Binned distribution for a numeric audio feature.
export function HistogramChart({ hist, color }: { hist: Histogram; color: string }) {
  const data = hist.bins.map((b) => ({
    label: Number.isInteger(b.x0) ? `${b.x0}` : b.x0.toFixed(1),
    range: `${b.x0}–${b.x1}`,
    count: b.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "var(--text-faint)" }}
          interval="preserveStartEnd"
          axisLine={{ stroke: "var(--border)" }}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--text-faint)" }}
          axisLine={false}
          tickLine={false}
          width={32}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--text)",
          }}
          labelFormatter={(_, p) => (p && p[0] ? `Range ${p[0].payload.range}` : "")}
          formatter={(v: number) => [`${v} tracks`, ""]}
        />
        <Bar dataKey="count" fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
