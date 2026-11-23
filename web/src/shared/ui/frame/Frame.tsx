import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

// The brand mark: a dot-matrix "p", five rows of three dots. It is a logo, not a panel: it has no relation to any
// board's geometry.
const MARK_ROWS = ["##.", "#.#", "##.", "#..", "#.."];

const DOTS = MARK_ROWS.flatMap((row, y) => [...row].map((c, x) => ({ id: `${x}-${y}`, lit: c === "#", x, y })));

function Mark() {
  return (
    <svg viewBox="0 0 12 20" aria-hidden="true" focusable="false" className="h-6 w-auto flex-none">
      {DOTS.map((d) => (
        <circle
          key={d.id}
          className={d.lit ? "fill-accent group-hover:fill-accent-hover" : "fill-border"}
          cx={2 + d.x * 4}
          cy={2 + d.y * 4}
          r={1.5}
        />
      ))}
    </svg>
  );
}

/**
 * The frame every screen is shown inside: a banner with the product's name as the link home, and the main region.
 * Primary navigation and the account control go in the band when something exists for them to lead to.
 */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-base font-normal leading-normal text-text">
      <header className="flex h-band flex-none items-center gap-6 border-b-(length:--line) border-border bg-surface px-4 tablet:h-band-wide tablet:px-6 desktop:px-8">
        <Link
          to="/"
          className="group -ml-1 inline-flex min-h-tap items-center gap-2 rounded-sm px-1 text-lg font-bold leading-tight text-text no-underline"
        >
          <Mark />
          <span>panelator</span>
        </Link>
      </header>
      <main className="block min-w-0 flex-1">{children}</main>
    </div>
  );
}
