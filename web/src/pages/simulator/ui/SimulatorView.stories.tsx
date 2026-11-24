import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frame } from "@/shared/ui";
import type { PlacementRow } from "../model/types";
import { SimulatorView, type SimulatorViewProps } from "./SimulatorView";

const placements: PlacementRow[] = [
  { module: "spike-image", updateHz: 30, width: 128, height: 64 },
  { module: "spike-clock", updateHz: 1, width: 64, height: 32 },
  { module: "spike-scroll", updateHz: 60, width: 128, height: 16 },
];
const base: SimulatorViewProps = { state: "running", panel: { width: 128, height: 64 }, placements, tick: 120 };

const meta = {
  title: "pages/simulator",
  render: (args: SimulatorViewProps) => (
    <Frame>
      <SimulatorView {...args} />
    </Frame>
  ),
  args: base,
} satisfies Meta<SimulatorViewProps>;
export default meta;
type Story = StoryObj<typeof meta>;

/** `running`: ticks advance; the control reads Pause. */
export const Default: Story = {};
/** `loading`: the panel's place is held at its size, unlit; no tick and no control yet. */
export const Loading: Story = { args: { state: "loading", tick: 0 } };
/** `paused`: the tick stands still; the control reads Resume. */
export const Paused: Story = { args: { state: "paused", tick: 248 } };
/** `paused` at the start under reduced motion: the line under the run bar. */
export const PausedForReducedMotion: Story = { args: { state: "paused", tick: 0, reducedMotionNote: true } };
/** `failed`: the design's sentence, the engine's message, and the control that loads the simulator again. */
export const Failed: Story = {
  args: {
    state: "failed",
    message:
      "placement 1 (spike-clock): pn_update at tick 1284 ended in an error: draw_text: [262136, 262160) is outside the 262144-byte memory",
  },
};
