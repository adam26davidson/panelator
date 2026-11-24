// Simulator (spec 115 AC-14, section 7): the frame, a heading, the panel as raw pixels, the run bar (state, tick,
// the pause control) and the readouts (the panel's size, the three placements). States: Default is `running`;
// Loading, Paused and Failed are the other three. The view takes its state as properties, as the page's view does.
// The panel is a golden frame of scene `spike` (ticks 120 and 248), enlarged without smoothing.
import frame120 from "../../../sdk/conformance/golden/spike/tick-120.png";
import frame248 from "../../../sdk/conformance/golden/spike/tick-248.png";
import { Button, PageHeading } from "../../../web/src/shared/ui/index.ts";
import { GroupHeading, type Panel, PanelView, Screen, WideColumn } from "./sim-kit.tsx";

export default { title: "simulator" };

interface Placement {
  module: string;
  /** The rate the loaded module declares; unknown until it is loaded. */
  updateHz?: number;
  width: number;
  height: number;
}

type ViewState =
  | { state: "loading" }
  | { state: "running"; tick: number; frame: string }
  | { state: "paused"; tick: number; frame: string }
  | { state: "failed"; message: string };

// What scenes/spike.json gives (the panel, the placements in their order and sizes) and what the three modules
// declare (the rates). The page reads all of it; nothing here is a constant of the app.
const PANEL: Panel = { width: 128, height: 64 };
const PLACEMENTS: Placement[] = [
  { module: "spike-image", updateHz: 30, width: 128, height: 64 },
  { module: "spike-clock", updateHz: 1, width: 64, height: 32 },
  { module: "spike-scroll", updateHz: 60, width: 128, height: 16 },
];

const STATE_TEXT = { loading: "Loading the simulator…", running: "Running", paused: "Paused" } as const;

function Dot({ state }: { state: "loading" | "running" | "paused" }) {
  const look =
    state === "running" ? "border-ok bg-ok" : state === "paused" ? "border-border-strong" : "border-border bg-border";
  return <span aria-hidden="true" className={`size-3 flex-none rounded-full border-(length:--line-focus) ${look}`} />;
}

/** State and tick on the left, the pause control at the right end. The bar keeps its height in every state. */
function RunBar({ view }: { view: Exclude<ViewState, { state: "failed" }> }) {
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
          <Button variant="secondary">{view.state === "running" ? "Pause" : "Resume"}</Button>
        </div>
      )}
    </div>
  );
}

function Readouts({ panel, placements }: { panel: Panel; placements: Placement[] }) {
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
            {placements.map((p) => (
              <tr key={p.module} className="border-b-(length:--line) border-border">
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

/** `failed`: the message region in place of the panel, the run bar and the readouts. */
function Failure({ message }: { message: string }) {
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
        <Button variant="primary">Load the simulator again</Button>
      </div>
    </div>
  );
}

function SimulatorView({ panel, placements, view }: { panel: Panel; placements: Placement[]; view: ViewState }) {
  const label = `LED panel, ${panel.width} by ${panel.height}, running the runtime spike's three widgets: a moving image, a clock and scrolling text`;
  return (
    <WideColumn>
      <PageHeading
        eyebrow="Runtime spike"
        title="Simulator"
        lead="The runtime spike's three widgets, running in your browser from the same WebAssembly modules the board runs."
      />
      {view.state === "failed" ? (
        <Failure message={view.message} />
      ) : (
        <div className="grid gap-8 desktop:grid-cols-[minmax(0,1fr)_var(--size-side)]">
          <div className="flex min-w-0 flex-col gap-3">
            <PanelView panel={panel} frame={view.state === "loading" ? undefined : view.frame} label={label} />
            <RunBar view={view} />
          </div>
          <Readouts
            panel={panel}
            placements={
              view.state === "loading" ? placements.map((p) => ({ ...p, updateHz: undefined })) : placements
            }
          />
        </div>
      )}
    </WideColumn>
  );
}

const render = (view: ViewState) => (
  <Screen>
    <SimulatorView panel={PANEL} placements={PLACEMENTS} view={view} />
  </Screen>
);

/** `running`: ticks advance; the control reads Pause. */
export const Default = () => render({ state: "running", tick: 120, frame: frame120 });

/** `loading`: the panel's place is held at its size, unlit; no tick and no control yet. */
export const Loading = () => render({ state: "loading" });

/** `paused`: the tick stands still; the control reads Resume. */
export const Paused = () => render({ state: "paused", tick: 248, frame: frame248 });

/** `failed`: the design's sentence, the engine's message, and the control that loads the simulator again. */
export const Failed = () =>
  render({
    state: "failed",
    message:
      "placement 1 (spike-clock): trap in pn_update at tick 1284: draw_text: the string at 0x0003fff8, length 24, reaches past the module's memory",
  });
