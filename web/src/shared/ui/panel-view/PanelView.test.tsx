import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelView, panelScale } from "./PanelView";

afterEach(() => vi.unstubAllGlobals());

describe("panelScale", () => {
  it("is the largest whole number that fits, and at least 1", () => {
    // the design's table: 388px, 736px and 1028px of room for 128 LEDs
    expect([388, 736, 1028].map((room) => panelScale(room, 128))).toEqual([3, 5, 8]);
    expect(panelScale(128, 128)).toBe(1);
    expect(panelScale(127, 128)).toBe(1);
    expect(panelScale(10, 128)).toBe(1);
    expect(panelScale(1028, 96)).toBe(10);
  });
});

describe("PanelView", () => {
  it("renders a canvas whose backing size is the properties' and which is named by them", () => {
    for (const [width, height] of [
      [128, 64],
      [96, 16],
      [200, 3],
    ] as const) {
      const { unmount } = render(<PanelView width={width} height={height} label={`panel ${width}`} />);
      const canvas = screen.getByRole("img", { name: `panel ${width}` }) as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([width, height]);
      expect(canvas.style.width).toBe(`${width}px`);
      unmount();
    }
  });
  it("hands the canvas to its caller and asks for no context itself", () => {
    const seen: (HTMLCanvasElement | null)[] = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    render(<PanelView width={4} height={2} label="p" onCanvas={(c) => seen.push(c)} />);
    expect(seen[0]).toBeInstanceOf(HTMLCanvasElement);
    expect(spy).not.toHaveBeenCalled();
  });
  it("is not in the focus order while the panel fits", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(<PanelView width={4} height={2} label="p" />);
    expect(screen.queryByRole("group", { name: "Panel" })).toBeNull();
  });
  it("makes the well a focusable group that scrolls when the panel is wider than the room at 1", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(<PanelView width={400} height={2} label="p" />);
    const group = screen.getByRole("group", { name: "Panel" });
    expect(group.getAttribute("tabindex")).toBe("0");
    expect((screen.getByRole("img") as HTMLCanvasElement).style.width).toBe("400px");
  });
  it("enlarges by the whole-number scale of the measured room", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    render(<PanelView width={128} height={64} label="p" />);
    expect((screen.getByRole("img") as HTMLCanvasElement).style.width).toBe("384px");
  });
});
