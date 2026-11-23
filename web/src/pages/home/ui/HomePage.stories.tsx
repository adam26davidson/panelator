import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frame } from "@/shared/ui";
import { HomePage } from "./HomePage";

const meta = {
  title: "pages/home",
  render: () => (
    <Frame>
      <HomePage />
    </Frame>
  ),
} satisfies Meta;
export default meta;

export const Default: StoryObj<typeof meta> = {};
