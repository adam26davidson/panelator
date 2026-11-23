import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageHeading } from "./PageHeading";

const meta = {
  title: "shared/PageHeading",
  component: PageHeading,
  args: { eyebrow: "Eyebrow", title: "The screen's heading", lead: "One line that says what this screen is for." },
} satisfies Meta<typeof PageHeading>;
export default meta;

export const Neutral: StoryObj<typeof meta> = {};
export const Danger: StoryObj<typeof meta> = { args: { tone: "danger" } };
