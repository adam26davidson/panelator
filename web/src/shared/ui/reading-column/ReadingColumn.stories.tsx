import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReadingColumn } from "./ReadingColumn";

const meta = {
  title: "shared/ReadingColumn",
  component: ReadingColumn,
  args: { children: <p>Text screens are held to one column, at most 680px wide.</p> },
} satisfies Meta<typeof ReadingColumn>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
