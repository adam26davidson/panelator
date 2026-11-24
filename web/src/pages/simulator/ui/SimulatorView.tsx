import { type ReactNode, useEffect } from "react";
import { Button, PageHeading, PanelView } from "@/shared/ui";
import type { PlacementRow } from "../model/types";

export type SimulatorState = "loading" | "running" | "paused" | "failed";

export interface SimulatorViewProps {
  state: SimulatorState;
  panel: { width: number; height: number };
  placements: PlacementRow[];
  tick: number;
  /** The line shown under the run bar when the page started paused for reduced motion. */
  reducedMotionNote?: boolean;
  /** The engine's message, in `failed`. */
  message?: string;
  /** Move focus to the retry control when it appears (the pause control had focus). */
  focusRetry?: boolean;
  onToggle?: () => void;
  onRetry?: () => void;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
}

const STATE_TEXT = { loading: "Loading the simulator…", running: "Running", paused: "Paused" } as const;

function WideColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[calc(var(--size-wide)+2*var(--pad-x))] flex-col gap-6 px-(--pad-x) pt-6 pb-8 [--pad-x:var(--space-4)] tablet:pt-8 tablet:[--pad-x:var(--space-6)] desktop:[--pad-x:var(--space-8)]">
      {children}
    </div>
  );
}

function GroupHeading({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <h2 className={`text-sm font-semibold tracking-wide uppercase ${tone === "danger" ? "text-danger" : "text-muted"}`}>
      {children}
    </h2>
  );
}

function Dot({ state }: { state: "loading" | "running" | "paused" }) {
  const look =
    state === "running" ? "border-ok bg-ok" : state === "paused" ? "border-border-strong" : "border-border bg-border";
  return <span aria-hidden="true" className={`size-3 flex-none rounded-full border-(length:--line-focus) ${look}`} />;
}

function RunBar({
  state,
  tick,
  onToggle,
}: {
  state: "loading" | "running" | "paused";
  tick: number;
  onToggle?: () => void;
}) {
  return (
    <div className="flex min-h-tap items-center gap-4">
      <p role="status" className="flex items-center gap-2 font-semibold">
        <Dot state={state} />
        {STATE_TEXT[state]}
      </p>
      {state !== "loading" && (
        <p className="flex items-baseline gap-2">
          <span className="text-sm text-muted">Tick</span>
          <span className="font-mono tabular-nums">{tick}</span>
        </p>
      )}
      {state !== "loading" && (
        <div className="ml-auto grid w-control flex-none">
          <Button variant="secondary" onClick={onToggle} data-sim-pause="">
            {state === "running" ? "Pause" : "Resume"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Readouts({ panel, placements }: { panel: { width: number; height: number }; placements: PlacementRow[] }) {
  return (
    <div className="grid content-start gap-8 tablet:grid-cols-[var(--size-side)_minmax(0,1fr)] desktop:grid-cols-1">
      <section className="flex flex-col gap-2">
        <GroupHeading>Panel</GroupHeading>
        <p className="font-mono text-lg leading-tight">
          {panel.width} × {panel.height} LEDs
        </p>
        <p className="text-sm text-muted">Raw pixels: one square per LED, no gaps and no glow.</p>
      </section>
      <section className="flex flex-col gap-2">
        <GroupHeading>Placements</GroupHeading>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b-(length:--line) border-border text-sm text-muted">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Module
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Rate
              </th>
              <th scope="col" className="py-2 font-semibold">
                Layer
              </th>
            </tr>
          </thead>
          <tbody>
            {placements.map((p, i) => (
              <tr key={i} className="border-b-(length:--line) border-border">
                <th scope="row" className="py-3 pr-4 font-mono text-sm font-normal">
                  {p.module}
                </th>
                <td className="py-3 pr-4 whitespace-nowrap tabular-nums">
                  {p.updateHz === undefined ? (
                    <span className="text-muted">
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">not loaded yet</span>
                    </span>
                  ) : (
                    `${p.updateHz} Hz`
                  )}
                </td>
                <td className="py-3 whitespace-nowrap tabular-nums">
                  {p.width} × {p.height}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted">In drawing order, back to front.</p>
      </section>
    </div>
  );
}

function Failure({ message, focusRetry, onRetry }: { message: string; focusRetry?: boolean; onRetry?: () => void }) {
  useEffect(() => {
    if (focusRetry) document.querySelector<HTMLElement>("[data-sim-retry]")?.focus();
  }, [focusRetry]);
  return (
    <div
      role="alert"
      className="flex max-w-reading flex-col gap-4 rounded-md border-(length:--line) border-border bg-surface p-4 tablet:p-6"
    >
      <div className="flex flex-col gap-2">
        <GroupHeading tone="danger">Simulator error</GroupHeading>
        <p className="text-lg font-bold leading-tight">The simulator stopped</p>
      </div>
      <p>
        It could not load or run one of its widgets, so the panel cannot be shown. Loading the simulator again may fix
        that.
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted">What the engine reported</p>
        <p className="rounded-sm border-(length:--line) border-border bg-bg p-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
          {message}
        </p>
      </div>
      <div className="flex flex-col tablet:flex-row">
        <Button variant="primary" onClick={onRetry} data-sim-retry="">
          Load the simulator again
        </Button>
      </div>
    </div>
  );
}

/** The simulator screen from its properties alone: no WebAssembly and no canvas context. */
export function SimulatorView(props: SimulatorViewProps) {
  const { state, panel, placements, tick } = props;
  const label = `LED panel, ${panel.width} by ${panel.height}, running the runtime spike's three widgets: a moving image, a clock and scrolling text`;
  return (
    <WideColumn>
      <title>Simulator · panelator</title>
      <PageHeading
        eyebrow="Runtime spike"
        title="Simulator"
        lead="The runtime spike's three widgets, running in your browser from the same WebAssembly modules the board runs."
      />
      {state === "failed" ? (
        <Failure message={props.message ?? ""} focusRetry={props.focusRetry} onRetry={props.onRetry} />
      ) : (
        <div className="grid gap-8 desktop:grid-cols-[minmax(0,1fr)_var(--size-side)]">
          <div className="flex min-w-0 flex-col gap-3">
            <PanelView width={panel.width} height={panel.height} label={label} onCanvas={props.onCanvas} />
            <RunBar state={state} tick={tick} onToggle={props.onToggle} />
            {props.reducedMotionNote && (
              <p className="-mt-1 text-sm text-muted">
                Paused because your system asks for reduced motion. Resume starts the panel.
              </p>
            )}
          </div>
          <Readouts
            panel={panel}
            placements={state === "loading" ? placements.map((p) => ({ ...p, updateHz: undefined })) : placements}
          />
        </div>
      )}
    </WideColumn>
  );
}
