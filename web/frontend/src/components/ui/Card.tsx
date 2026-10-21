import type { CSSProperties, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({
  step,
  title,
  subtitle,
  right,
}: {
  step?: number | string;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="card__header">
      {step !== undefined && <div className="card__step">{step}</div>}
      <div className="card__title-wrap">
        <h3>{title}</h3>
        {subtitle && <span className="small muted">{subtitle}</span>}
      </div>
      <div className="card__spacer" />
      {right}
    </div>
  );
}

export function CardBody({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`card__body ${className}`} style={style}>
      {children}
    </div>
  );
}
