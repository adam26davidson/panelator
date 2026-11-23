import type { ReactNode } from "react";

/** The main region at its reading width, for text screens. A full-width screen leaves it out. */
export function ReadingColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[calc(var(--size-reading)+2*var(--pad-x))] flex-col gap-8 px-(--pad-x) pt-8 pb-12 [--pad-x:var(--space-4)] tablet:pt-12 tablet:pb-16 tablet:[--pad-x:var(--space-6)] desktop:pt-16 desktop:[--pad-x:var(--space-8)]">
      {children}
    </div>
  );
}
