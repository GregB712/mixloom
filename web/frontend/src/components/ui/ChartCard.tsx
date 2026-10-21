import type { ReactNode } from "react";
import { Card, CardBody } from "./Card";

export function ChartCard({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardBody>
        <div className="chartcard__title">
          <span>{title}</span>
          {right}
        </div>
        {children}
      </CardBody>
    </Card>
  );
}
