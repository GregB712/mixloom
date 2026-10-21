import type { ReactNode } from "react";

export function EmptyState({
  icon = "📭",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden>
        {icon}
      </div>
      <h3>{title}</h3>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Callout({
  tone = "default",
  children,
}: {
  tone?: "default" | "warn" | "danger" | "ok";
  children: ReactNode;
}) {
  const cls = tone === "default" ? "callout" : `callout callout--${tone}`;
  return <div className={cls}>{children}</div>;
}
