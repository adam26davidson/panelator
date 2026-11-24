import { type Live, presentFrame, runLive, type Scene } from "@panelator/simulator";
import { useCallback, useEffect, useRef, useState } from "react";
import { initialRows, loadSimulator, SPIKE } from "../model/load";
import type { PlacementRow } from "../model/types";
import { type SimulatorState, SimulatorView } from "./SimulatorView";

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The page: loads the files, runs the scene live, and gives the view its state. Leaving the page stops the run. */
export function SimulatorPage() {
  const [state, setState] = useState<SimulatorState>("loading");
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<PlacementRow[]>(() => initialRows(SPIKE));
  const [message, setMessage] = useState("");
  const [note, setNote] = useState(false);
  const [focusRetry, setFocusRetry] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<Live | null>(null);
  const scene = useRef<Scene | null>(null);

  useEffect(() => {
    let cancelled = false;
    let mine: Live | undefined;
    const fail = (e: unknown) => {
      if (cancelled) return;
      console.error(e);
      mine?.stop();
      setFocusRetry(document.activeElement?.hasAttribute("data-sim-pause") ?? false);
      setMessage(e instanceof Error ? e.message : String(e));
      setState("failed");
    };
    void (async () => {
      try {
        const loaded = await loadSimulator(SPIKE);
        if (cancelled) return;
        const context = canvas.current?.getContext("2d");
        if (!context) throw new Error("the browser gave no 2D canvas context");
        scene.current = loaded;
        setRows(
          SPIKE.placements.map((p, i) => ({
            module: p.module,
            width: p.width,
            height: p.height,
            updateHz: loaded.placements[i]?.updateHz,
          })),
        );
        const paused = reducedMotion();
        if (paused) {
          loaded.step();
          presentFrame(context, loaded.frame, loaded.panel.width, loaded.panel.height);
        }
        mine = runLive(loaded, {
          context,
          clock: () => performance.now(),
          requestFrame: (cb) => requestAnimationFrame(cb),
          onTick: setTick,
          onError: fail,
        });
        live.current = mine;
        if (paused) mine.pause();
        setTick(Math.max(loaded.tick, 0));
        setNote(paused);
        setState(paused ? "paused" : "running");
      } catch (e) {
        fail(e);
      }
    })();
    return () => {
      cancelled = true;
      mine?.stop();
      live.current = null;
    };
  }, [attempt]);

  const onToggle = useCallback(() => {
    if (state === "running") {
      live.current?.pause();
      setState("paused");
    } else if (state === "paused") {
      live.current?.resume();
      setNote(false);
      setState("running");
    }
  }, [state]);

  const onCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvas.current = el;
  }, []);

  const onRetry = useCallback(() => {
    setState("loading");
    setFocusRetry(false);
    setRows(initialRows(SPIKE));
    setAttempt((a) => a + 1);
    document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
  }, []);

  return (
    <SimulatorView
      state={state}
      panel={SPIKE.panel}
      placements={rows}
      tick={tick}
      reducedMotionNote={note}
      message={message}
      focusRetry={focusRetry}
      onToggle={onToggle}
      onRetry={onRetry}
      onCanvas={onCanvas}
    />
  );
}
