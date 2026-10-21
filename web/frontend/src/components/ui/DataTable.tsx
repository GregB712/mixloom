import { Button } from "./Button";

export function DataTable({
  columns,
  rows,
  total,
  offset,
  limit,
  onPage,
}: {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  offset: number;
  limit: number;
  onPage: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} title={row[c]}>
                    {row[c]}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted" style={{ textAlign: "center", padding: "var(--space-5)" }}>
                  No matching rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span className="small faint">
          {from}–{to} of {total.toLocaleString()}
        </span>
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
          Prev
        </Button>
        <Button variant="secondary" size="sm" disabled={to >= total} onClick={() => onPage(offset + limit)}>
          Next
        </Button>
      </div>
    </div>
  );
}
