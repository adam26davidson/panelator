import type { Meta, StoryObj } from "@storybook/react-vite";
import { SimulatorView } from "./SimulatorView";

// What scenes/spike.json gives (the panel, the placements in their order) and what the three modules declare (the
// rates), as the page reads them. The stories draw no frame: the panel shows its unlit place.
const PANEL = { width: 128, height: 64 };
const PLACEMENTS = [
  { name: "spike-image", updateHz: 30, width: 128, height: 64 },
  { name: "spike-clock", updateHz: 1, width: 64, height: 32 },
  { name: "spike-scroll", updateHz: 60, width: 128, height: 16 },
];

const meta = {
  title: "pages/simulator",
  component: SimulatorView,
  args: {
    panel: PANEL,
    placements: PLACEMENTS,
    view: { state: "running", tick: 120 },
    onToggle: () => undefined,
    onRetry: () => undefined,
  },
} satisfies Meta<typeof SimulatorView>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
export const Loading: StoryObj<typeof meta> = { args: { view: { state: "loading" } } };
export const Paused: StoryObj<typeof meta> = { args: { view: { state: "paused", tick: 248 } } };
export const PausedByReducedMotion: StoryObj<typeof meta> = {
  args: { view: { state: "paused", tick: 0, reducedMotion: true } },
};
export const Failed: StoryObj<typeof meta> = {
  args: {
    view: {
      state: "failed",
      message:
        "placement 1 (spike-clock) failed in pn_update at tick 1284: memory: the range 262136..262160 is outside the 262144 bytes of memory",
    },
  },
};
