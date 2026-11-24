import {
  createScene,
  type LiveRun,
  liveEnvironment,
  loadModule,
  parseFont,
  presentFrame,
  readScene,
  runLive,
  type Scene,
} from "@panelator/simulator";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSize } from "@/shared/ui";
import sceneText from "../../../../../sdk/conformance/scenes/spike.json?raw";
import type { PlacementRow, ViewState } from "../ui/SimulatorView";

const BASE = "/sim";

async function fetchFile(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`);
  } catch (error) {
    throw new Error(
      `${path.split("/").pop()}: could not be fetched (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) throw new Error(`${path.split("/").pop()}: could not be fetched (${response.status})`);
  return response;
}
const fetchBytes = async (path: string) => new Uint8Array(await (await fetchFile(path)).arrayBuffer());
// The scene is part of the bundle (spec 115 AC-2): the first render knows the panel and the placements.
const SCENE = readScene(sceneText);
const PLACEHOLDERS: PlacementRow[] = SCENE.placements.map((p) => ({
  name: p.module,
  width: p.width,
  height: p.height,
}));
const fetchText = async (path: string) => (await fetchFile(path)).text();

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Loads the scene `scenes/spike.json` describes (bundled) and runs it live; leaving the page stops the run. */
export function useSimulator() {
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const [panel, setPanel] = useState<PanelSize>(SCENE.panel);
  const [placements, setPlacements] = useState<PlacementRow[]>(PLACEHOLDERS);
  const [attempt, setAttempt] = useState(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const run = useRef<LiveRun>(undefined);
  const paused = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let live: LiveRun | undefined;
    const fail = (error: unknown) => {
      console.error(error);
      live?.stop();
      if (!cancelled) setView({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    };
    setView({ state: "loading" });
    (async () => {
      const spec = SCENE;
      setPlacements(PLACEHOLDERS);
      const names = [...new Set(spec.placements.map((p) => p.module))];
      const [font1, font2, ...rest] = await Promise.all([
        fetchText("fonts/spleen-5x8.bdf"),
        fetchText("fonts/spleen-8x16.bdf"),
        ...names.map((n) => fetchBytes(`modules/${n}.wasm`)),
        ...spec.assets.map((a) => fetchBytes(`assets/${a.file}`)),
      ]);
      const moduleBytes = rest.slice(0, names.length) as Uint8Array[];
      const assetBytes = rest.slice(names.length) as Uint8Array[];
      const modules = new Map<string, Awaited<ReturnType<typeof loadModule>>>();
      for (const [i, name] of names.entries()) modules.set(name, await loadModule(moduleBytes[i] as Uint8Array));
      const scene: Scene = await createScene({
        panel: spec.panel,
        fonts: { 1: parseFont(font1 as string), 2: parseFont(font2 as string) },
        assets: spec.assets.map((a, i) => ({ ...a, bytes: assetBytes[i] as Uint8Array })),
        placements: spec.placements.map((p) => ({ ...p, name: p.module, module: modules.get(p.module) as never })),
        environment: liveEnvironment(),
      });
      if (cancelled) return;
      setPlacements(
        scene.placements.map((p) => ({ name: p.name, updateHz: p.updateHz, width: p.width, height: p.height })),
      );
      const context = canvas.current?.getContext("2d");
      if (!context) throw new Error("the page has no 2D canvas context");
      const still = reducedMotion();
      if (still) {
        scene.step();
        presentFrame(context, scene.frame, scene.panel.width, scene.panel.height);
      }
      live = runLive(scene, {
        context,
        clock: () => performance.now(),
        requestFrame: (cb) => requestAnimationFrame(cb),
        onTick: (tick) => setView({ state: "running", tick }),
        onError: fail,
      });
      run.current = live;
      paused.current = still;
      if (still) {
        live.pause();
        setView({ state: "paused", tick: scene.tick, reducedMotion: true });
      } else setView({ state: "running", tick: Math.max(scene.tick, 0) });
      sceneTick.current = () => scene.tick;
    })().catch(fail);
    return () => {
      cancelled = true;
      live?.stop();
      run.current = undefined;
    };
  }, [attempt]);

  const sceneTick = useRef<() => number>(() => 0);
  const toggle = useCallback(() => {
    const r = run.current;
    if (!r) return;
    if (paused.current) {
      paused.current = false;
      r.resume();
      setView({ state: "running", tick: sceneTick.current() });
    } else {
      paused.current = true;
      r.pause();
      setView({ state: "paused", tick: sceneTick.current() });
    }
  }, []);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    queueMicrotask(() => document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true }));
  }, []);
  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvas.current = el;
  }, []);
  return { view, panel, placements, toggle, retry, canvasRef };
}
