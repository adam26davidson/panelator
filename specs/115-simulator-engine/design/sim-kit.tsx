// Shared pieces of spec 115's design stories. Not a story file.
//
// `@panelator/web` exists on main, so the frame, the heading, the reading column and the buttons are the app's own
// components, imported from its source, and the classes are the app's Tailwind utilities (design.css loads the app's
// token set). `@panelator/simulator` does not exist yet, so the panel is drawn from a golden frame of
// sdk/conformance (spec 115 section 7); the implementation puts the live canvas in its place. flow.md maps every
// piece here to the component the app builds.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { WithProviders } from "../../../web/src/shared/lib/index.ts";
import { Frame } from "../../../web/src/shared/ui/index.ts";
import "./design.css";

/** The app's frame with the router it needs. Every story renders inside it. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="design-root">
      <WithProviders>
        <Frame>{children}</Frame>
      </WithProviders>
    </div>
  );
}

/* ------------------------------------------------------------------ shared/ui: PanelView */

export interface Panel {
  width: number;
  height: number;
}

/**
 * The panel view (`shared/ui`, reused by `layout-editor`): a well that holds one panel, raw pixels, enlarged by a
 * whole number of CSS pixels per LED. The scale is the largest whole number at which the panel fits the well's
 * content width (less the two edge lines), and at least 1; a panel wider than the well at 1 makes the well, not the
 * page, scroll sideways. The 1px line around the panel is the panel's edge: everything inside it is LEDs, so a black
 * LED at the edge is told from the page.
 *
 * `frame` is the address of an image of the frame (the stories' stand-in for the live canvas); without it the
 * panel's place is held at its size, unlit.
 */
export function PanelView({ panel, frame, label }: { panel: Panel; frame?: string; label: string }) {
  const well = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = well.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const room = el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight) - 2;
      setScale(Math.max(1, Math.floor(room / panel.width)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panel.width]);
  const size = { width: panel.width * scale, height: panel.height * scale };
  return (
    <div
      ref={well}
      className="-mx-4 overflow-x-auto border-y-(length:--line) border-border bg-surface py-3 tablet:mx-[0px] tablet:rounded-md tablet:border-(length:--line) tablet:p-4"
    >
      <div className="mx-auto w-fit border-(length:--line) border-border-strong bg-panel-off">
        {frame ? (
          // The app renders <canvas role="img" aria-label={label} width={panel.width} height={panel.height}>.
          <img
            src={frame}
            alt={label}
            width={panel.width}
            height={panel.height}
            className="block max-w-none [image-rendering:pixelated]"
            style={size}
          />
        ) : (
          <div style={size} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pages/simulator: layout pieces */

/** The simulator's main region: full width, held to the wide column, with the frame's side padding. */
export function WideColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[calc(var(--size-wide)+2*var(--pad-x))] flex-col gap-6 px-(--pad-x) pt-6 pb-8 [--pad-x:var(--space-4)] tablet:pt-8 tablet:[--pad-x:var(--space-6)] desktop:[--pad-x:var(--space-8)]">
      {children}
    </div>
  );
}

/** A readout group's heading: the eyebrow look, as an `h2`. */
export function GroupHeading({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <h2 className={`text-sm font-semibold tracking-wide uppercase ${tone === "danger" ? "text-danger" : "text-muted"}`}>
      {children}
    </h2>
  );
}
