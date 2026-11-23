import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frame } from "@/shared/ui";
import { NotFoundPage } from "./NotFoundPage";

const meta = {
  title: "pages/not-found",
  render: () => (
    <Frame>
      <NotFoundPage />
    </Frame>
  ),
} satisfies Meta;
export default meta;

export const Default: StoryObj<typeof meta> = {};
