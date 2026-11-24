import type { Meta, StoryObj } from "@storybook/react-vite";
import { PanelView } from "./PanelView";

const meta = {
  title: "shared/PanelView",
  component: PanelView,
  args: { panel: { width: 128, height: 64 }, label: "LED panel, 128 by 64" },
  decorators: [
    (Story) => (
      <div className="mx-auto flex w-full max-w-wide flex-col gap-3 px-4 py-6 tablet:px-6">
        <p className="text-sm text-muted">The panel view enlarges the panel by a whole number of pixels per LED.</p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanelView>;
export default meta;

export const Wide: StoryObj<typeof meta> = {};
export const Narrow: StoryObj<typeof meta> = {
  args: { panel: { width: 32, height: 16 }, label: "LED panel, 32 by 16" },
};
