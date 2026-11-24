import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/shared/lib";
import type { PlacementRow } from "../model/types";
import { SimulatorView, type SimulatorViewProps } from "./SimulatorView";

const placements: PlacementRow[] = [
  { module: "spike-image", updateHz: 30, width: 128, height: 64 },
  { module: "spike-clock", updateHz: 1, width: 64, height: 32 },
  { module: "spike-scroll", updateHz: 0, width: 128, height: 16 },
];
const base: SimulatorViewProps = { state: "running", panel: { width: 128, height: 64 }, placements, tick: 120 };
const show = async (props: Partial<SimulatorViewProps>) => {
  renderUi(<SimulatorView {...base} {...props} />);
  return screen.findByRole("heading", { level: 1, name: "Simulator" });
};

describe("SimulatorView", () => {
  it("running: the panel with its size and name, the tick, Pause and the placements", async () => {
    await show({});
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([128, 64]);
    expect(canvas.getAttribute("aria-label")).toBe(
      "LED panel, 128 by 64, running the runtime spike's three widgets: a moving image, a clock and scrolling text",
    );
    expect(screen.getByRole("status").textContent).toBe("Running");
    expect(screen.getByText("128 × 64 LEDs")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "spike-image30 Hz128 × 64",
      "spike-clock1 Hz64 × 32",
      "spike-scroll0 Hz128 × 16",
    ]);
    expect(document.title).toBe("Simulator · panelator");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
  it("loading: the panel's place is held, no tick, no control, the rates not loaded yet", async () => {
    await show({ state: "loading", tick: 0 });
    expect(screen.getByRole("status").textContent).toBe("Loading the simulator…");
    expect(screen.getByRole("img")).toBeTruthy();
    expect(screen.queryByText("Tick")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByText("not loaded yet")).toHaveLength(3);
    expect(screen.getByText("spike-image")).toBeTruthy();
  });
  it("paused: Resume, and the reduced-motion line only when asked", async () => {
    const onToggle = vi.fn();
    await show({ state: "paused", tick: 0, reducedMotionNote: true, onToggle });
    expect(screen.getByRole("status").textContent).toBe("Paused");
    expect(screen.getByText(/Paused because your system asks for reduced motion/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it("paused by the control shows no reduced-motion line", async () => {
    await show({ state: "paused", tick: 5 });
    expect(screen.queryByText(/reduced motion/)).toBeNull();
  });
  it("failed: the sentence, the engine's message and the control, in an alert; no panel", async () => {
    const onRetry = vi.fn();
    await show({ state: "failed", message: "placement 1 (spike-clock): boom", onRetry });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The simulator stopped")).toBeTruthy();
    expect(within(alert).getByText(/It could not load or run one of its widgets/)).toBeTruthy();
    expect(within(alert).getByText("placement 1 (spike-clock): boom")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "Load the simulator again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("failed moves focus to the retry control when asked", async () => {
    await show({ state: "failed", message: "x", focusRetry: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Load the simulator again" }));
  });
  it("a second panel size gives a canvas of that size", async () => {
    await show({ panel: { width: 96, height: 16 } });
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([96, 16]);
    expect(screen.getByText("96 × 16 LEDs")).toBeTruthy();
    expect(canvas.getAttribute("aria-label")).toContain("96 by 16");
  });
});
