import type { Meta, StoryObj } from "@storybook/react-vite";
import { Frame } from "@/shared/ui";
import { ErrorPage } from "./ErrorPage";

const meta = {
  title: "pages/error",
  render: () => (
    <Frame>
      <ErrorPage error={new Error("A route failed")} />
    </Frame>
  ),
} satisfies Meta;
export default meta;

export const Default: StoryObj<typeof meta> = {};
