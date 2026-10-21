import { Card } from "./Card";

export function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="metric">
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
      {sub && <div className="metric__sub">{sub}</div>}
    </Card>
  );
}
