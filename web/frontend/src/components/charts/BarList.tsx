import type { CountItem } from "../../api/client";

// Horizontal bar list for top-N categorical counts. Pure CSS, theme-aware.
export function BarList({ items, max }: { items: CountItem[]; max?: number }) {
  if (!items.length) return <p className="small faint">No data.</p>;
  const peak = Math.max(...items.map((i) => i.value), 1);
  const data = max ? items.slice(0, max) : items;
  return (
    <div className="barlist">
      {data.map((item) => (
        <div className="barrow" key={item.label}>
          <span className="barrow__label" title={item.label}>
            {item.label}
          </span>
          <div className="barrow__track">
            <div className="barrow__fill" style={{ width: `${(item.value / peak) * 100}%` }} />
          </div>
          <span className="barrow__value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
