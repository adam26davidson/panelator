import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frame } from "./Frame";

const meta = {
  title: "shared/Frame",
  component: Frame,
  args: { children: <p className="p-4">The matched route</p> },
} satisfies Meta<typeof Frame>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
