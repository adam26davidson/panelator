import { type Ref, useLayoutEffect, useRef, useState } from "react";

export interface PanelSize {
  width: number;
  height: number;
}

/**
 * The panel view (spec 115; `layout-editor` reuses it): a well that holds one panel as raw pixels, enlarged by a whole
 * number of CSS pixels per LED. The scale is the largest whole number at which the panel fits the well's content width
 * less the two edge lines, and at least 1; measured, and measured again when the well changes size. A panel wider than the
 * well at 1 makes the well, not the page, scroll sideways. The canvas's backing size is the panel's; its caller draws on it.
 */
export function PanelView({
  panel,
  label,
  canvasRef,
}: {
  panel: PanelSize;
  label: string;
  canvasRef?: Ref<HTMLCanvasElement>;
}) {
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
      const next = Math.max(1, Math.floor(room / panel.width));
      setScale(next);
      setScrolls(next * panel.width > room);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panel.width]);
  return (
    <div
      ref={well}
      {...(scrolls ? { tabIndex: 0, role: "group", "aria-label": "Panel" } : {})}
      className="-mx-4 overflow-x-auto border-y-(length:--line) border-border bg-surface py-3 tablet:mx-[0px] tablet:rounded-md tablet:border-(length:--line) tablet:p-4"
    >
      <div className="mx-auto w-fit border-(length:--line) border-border-strong bg-panel-off">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          width={panel.width}
          height={panel.height}
          className="block max-w-none [image-rendering:pixelated]"
          style={{ width: panel.width * scale, height: panel.height * scale }}
        />
      </div>
    </div>
  );
}
