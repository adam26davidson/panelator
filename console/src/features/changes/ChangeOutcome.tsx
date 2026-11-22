import type { ReactNode } from "react";
import { Icon } from "../../shared/ui/Icon.tsx";

export function Pending({ children }: { children: ReactNode }) {
  return (
    <div className="c-note pending" role="status">
      <span className="c-spin" style={{ marginTop: 2 }} />
      <span>{children}</span>
    </div>
  );
}

export function Refused({ children }: { children: ReactNode }) {
  return (
    <div className="c-note refused" role="alert">
      <span style={{ flex: "none" }}>{Icon.x()}</span>
      <span>{children}</span>
    </div>
  );
}
