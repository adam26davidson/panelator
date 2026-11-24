import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { Button, PageHeading, type PanelSize, PanelView } from "@/shared/ui";

export interface PlacementRow {
  name: string;
  /** The declared rate; unknown until the module is loaded. */
  updateHz?: number;
  width: number;
  height: number;
}

export type ViewState =
  | { state: "loading" }
  | { state: "running"; tick: number }
  | { state: "paused"; tick: number; reducedMotion?: boolean }
  | { state: "failed"; message: string };

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

function RunBar({ view, onToggle }: { view: Exclude<ViewState, { state: "failed" }>; onToggle: () => void }) {
  return (
    <div className="flex min-h-tap items-center gap-4">
      <p role="status" className="flex items-center gap-2 font-semibold">
        <Dot state={view.state} />
        {STATE_TEXT[view.state]}
      </p>
      {view.state !== "loading" && (
        <p className="flex items-baseline gap-2">
          <span className="text-sm text-muted">Tick</span>
          <span className="font-mono tabular-nums">{view.tick}</span>
        </p>
      )}
      {view.state !== "loading" && (
        <div className="ml-auto grid w-control flex-none">
          <Button variant="secondary" onClick={onToggle}>
            {view.state === "running" ? "Pause" : "Resume"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Readouts({ panel, placements }: { panel: PanelSize | undefined; placements: PlacementRow[] }) {
  return (
    <div className="grid content-start gap-8 tablet:grid-cols-[var(--size-side)_minmax(0,1fr)] desktop:grid-cols-1">
      <section className="flex flex-col gap-2">
        <GroupHeading>Panel</GroupHeading>
        {panel && (
          <p className="font-mono text-lg leading-tight">
            {panel.width} × {panel.height} LEDs
          </p>
        )}
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
              // The scene may place one module twice; the row's place is its identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for the life of a scene
              <tr key={i} className="border-b-(length:--line) border-border">
                <th scope="row" className="py-3 pr-4 font-mono text-sm font-normal">
                  {p.name}
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

function Failure({
  message,
  onRetry,
  retryRef,
}: {
  message: string;
  onRetry: () => void;
  retryRef: Ref<HTMLButtonElement>;
}) {
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
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-tap cursor-pointer items-center justify-center rounded-sm border-(length:--line) border-transparent bg-accent px-6 font-semibold leading-tight text-on-accent hover:bg-accent-hover"
        >
          Load the simulator again
        </button>
      </div>
    </div>
  );
}

export interface SimulatorViewProps {
  view: ViewState;
  /** The scene's panel; unknown only until the scene file is read. */
  panel: PanelSize | undefined;
  placements: PlacementRow[];
  onToggle: () => void;
  onRetry: () => void;
  /** Receives the canvas the frames are drawn on. */
  canvasRef?: Ref<HTMLCanvasElement>;
}

/** The page's view: everything it shows comes from its properties, so every state renders with no WebAssembly. */
export function SimulatorView({ view, panel, placements, onToggle, onRetry, canvasRef }: SimulatorViewProps) {
  const retry = useRef<HTMLButtonElement>(null);
  const before = useRef(view.state);
  useEffect(() => {
    // The pause control is removed when the run fails: focus goes to the control that loads again.
    if (view.state === "failed" && (before.current === "running" || before.current === "paused"))
      retry.current?.focus();
    before.current = view.state;
  }, [view.state]);
  const label = panel
    ? `LED panel, ${panel.width} by ${panel.height}, running the runtime spike's three widgets: a moving image, a clock and scrolling text`
    : "";
  return (
    <WideColumn>
      <title>Simulator · panelator</title>
      <PageHeading
        eyebrow="Runtime spike"
        title="Simulator"
        lead="The runtime spike's three widgets, running in your browser from the same WebAssembly modules the board runs."
      />
      {view.state === "failed" ? (
        <Failure message={view.message} onRetry={onRetry} retryRef={retry} />
      ) : (
        <div className="grid gap-8 desktop:grid-cols-[minmax(0,1fr)_var(--size-side)]">
          <div className="flex min-w-0 flex-col gap-3">
            {panel && <PanelView panel={panel} label={label} canvasRef={canvasRef} />}
            <RunBar view={view} onToggle={onToggle} />
            {view.state === "paused" && view.reducedMotion && (
              <p className="text-sm text-muted">
                Paused because your system asks for reduced motion. Resume starts the panel.
              </p>
            )}
          </div>
          <Readouts
            panel={panel}
            placements={view.state === "loading" ? placements.map((p) => ({ ...p, updateHz: undefined })) : placements}
          />
        </div>
      )}
    </WideColumn>
  );
}
