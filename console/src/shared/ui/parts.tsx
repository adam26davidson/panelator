import type { ReactNode } from "react";

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="c-card c-empty">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Skel({ h = 16, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="c-skel" style={{ height: h, width: w, borderRadius: r }} />;
}
