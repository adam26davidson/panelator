import type { Meta, StoryObj } from "@storybook/react-vite";
import { PanelView } from "./PanelView";

const meta = {
  title: "shared/ui/PanelView",
  component: PanelView,
  render: (args) => (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{args.label}</p>
      <PanelView {...args} />
    </div>
  ),
  args: { width: 128, height: 64, label: "LED panel, 128 by 64" },
} satisfies Meta<typeof PanelView>;
export default meta;

export const Default: StoryObj<typeof meta> = {};

/** Another panel size: the canvas follows the properties. */
export const OtherSize: StoryObj<typeof meta> = { args: { width: 96, height: 16, label: "LED panel, 96 by 16" } };
