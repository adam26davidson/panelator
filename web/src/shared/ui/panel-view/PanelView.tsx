import { useLayoutEffect, useRef, useState } from "react";

/**
 * The scale the panel is drawn at: the largest whole number of CSS pixels per LED at which `panelWidth` LEDs fit in
 * `room` CSS pixels, and at least 1.
 */
export function panelScale(room: number, panelWidth: number): number {
  return Math.max(1, Math.floor(room / panelWidth));
}

/**
 * The panel view: a well that holds one panel as raw pixels. The canvas's backing size is the panel's; CSS enlarges it by
 * a whole number of pixels per LED (the well's content width less the two edge lines decides), with no smoothing. A panel
 * wider than the room at 1 starts at the left and the well, not the page, scrolls sideways. The panel's size and its
 * accessible name come from the caller, and so does the context: the canvas element is handed to `onCanvas`.
 */
export function PanelView(props: {
  width: number;
  height: number;
  label: string;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
}) {
  const { width, height, label, onCanvas } = props;
  const well = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = well.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const room =
        el.clientWidth - Number.parseFloat(cs.paddingLeft || "0") - Number.parseFloat(cs.paddingRight || "0") - 2;
      const next = panelScale(room, width);
      setScale(next);
      setScrolls(width > room);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  const focusable = scrolls ? ({ tabIndex: 0, role: "group", "aria-label": "Panel" } as const) : {};
  return (
    <div
      ref={well}
      {...focusable}
      className="-mx-4 overflow-x-auto border-y-(length:--line) border-border bg-surface py-3 tablet:mx-[0px] tablet:rounded-md tablet:border-(length:--line) tablet:p-4"
    >
      <div className={`w-fit border-(length:--line) border-border-strong bg-panel-off ${scrolls ? "" : "mx-auto"}`}>
        <canvas
          ref={onCanvas}
          role="img"
          aria-label={label}
          width={width}
          height={height}
          className="block max-w-none [image-rendering:pixelated]"
          style={{ width: width * scale, height: height * scale }}
        />
      </div>
    </div>
  );
}
