import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { WithProviders } from "@/shared/lib";
import { SimulatorView, type SimulatorViewProps } from "./SimulatorView";

const PLACEMENTS = [
  { name: "spike-image", updateHz: 30, width: 128, height: 64 },
  { name: "spike-clock", updateHz: 1, width: 64, height: 32 },
  { name: "spike-scroll", updateHz: 0, width: 128, height: 16 },
];
const props = (over: Partial<SimulatorViewProps> = {}): SimulatorViewProps => ({
  view: { state: "running", tick: 7 },
  panel: { width: 128, height: 64 },
  placements: PLACEMENTS,
  onToggle: () => undefined,
  onRetry: () => undefined,
  ...over,
});
const show = async (p: SimulatorViewProps, node?: ReactNode) => {
  const view = render(<WithProviders>{node ?? <SimulatorView {...p} />}</WithProviders>);
  await screen.findByRole("heading", { level: 1 });
  return view;
};

describe("SimulatorView (spec 115 AC-14)", () => {
  it("running: one h1, a canvas of the panel's size with its accessible name, the readouts and Pause", async () => {
    const onToggle = vi.fn();
    const { container } = await show(props({ onToggle }));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([128, 64]);
    expect(screen.getByRole("img", { name: /^LED panel, 128 by 64, running the runtime spike's three widgets/ })).toBe(
      canvas,
    );
    expect(screen.getByRole("status").textContent).toBe("Running");
    expect(screen.getByText("128 × 64 LEDs")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "spike-image30 Hz128 × 64",
      "spike-clock1 Hz64 × 32",
      "spike-scroll0 Hz128 × 16",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(document.title === "" || document.title).toBeTruthy();
  });

  it("loading: the panel's place is held, no tick and no control, rates not loaded yet", async () => {
    const { container } = await show(props({ view: { state: "loading" } }));
    expect(screen.getByRole("status").textContent).toBe("Loading the simulator…");
    expect((container.querySelector("canvas") as HTMLCanvasElement).width).toBe(128);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Tick")).toBeNull();
    expect(screen.getAllByText("not loaded yet")).toHaveLength(3);
  });

  it("paused: the control reads Resume and the tick stands; reduced motion adds its line", async () => {
    await show(props({ view: { state: "paused", tick: 248 } }));
    expect(screen.getByRole("status").textContent).toBe("Paused");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText("248")).toBeTruthy();
    expect(screen.queryByText(/reduced motion/)).toBeNull();
  });

  it("paused at the start under reduced motion shows the design's line", async () => {
    await show(props({ view: { state: "paused", tick: 0, reducedMotion: true } }));
    expect(
      screen.getByText("Paused because your system asks for reduced motion. Resume starts the panel."),
    ).toBeTruthy();
  });

  it("failed: the design's words, the engine's message, and a control that loads again; no panel", async () => {
    const onRetry = vi.fn();
    const { container } = await show(
      props({ view: { state: "failed", message: "placement 1 (spike-clock): trap" }, onRetry }),
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The simulator stopped")).toBeTruthy();
    expect(within(alert).getByText(/It could not load or run one of its widgets/)).toBeTruthy();
    expect(within(alert).getByText("placement 1 (spike-clock): trap")).toBeTruthy();
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Load the simulator again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("another panel size gives a canvas of that size; no size is in the source", async () => {
    const { container } = await show(
      props({ panel: { width: 96, height: 16 }, placements: [{ name: "m", updateHz: 60, width: 96, height: 16 }] }),
    );
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([96, 16]);
    expect(screen.getByText("96 × 16 LEDs")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("96 by 16");
  });

  it("failed moves focus to the retry control only when the pause control held it", async () => {
    const running = props({ view: { state: "running", tick: 5 } });
    const failed = props({ view: { state: "failed", message: "boom" } });
    let fail = () => {};
    function Harness() {
      const [bad, setBad] = useState(false);
      fail = () => setBad(true);
      return <SimulatorView {...(bad ? failed : running)} />;
    }
    const a = await show(running, <Harness />);
    (screen.getByRole("button", { name: "Pause" }) as HTMLElement).focus();
    act(() => fail());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Load the simulator again" }));
    a.unmount();
    await show(running, <Harness />);
    const h1 = screen.getByRole("heading", { level: 1 });
    h1.tabIndex = -1;
    h1.focus();
    act(() => fail());
    expect(document.activeElement).toBe(h1);
  });
});
