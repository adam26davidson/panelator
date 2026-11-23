import type { Meta, StoryObj } from "@storybook/react-vite";
import { ButtonLink } from "./Button";

const meta = {
  title: "shared/ButtonLink",
  component: ButtonLink,
  args: { to: "/", children: "Go to the home page" },
} satisfies Meta<typeof ButtonLink>;
export default meta;

export const Primary: StoryObj<typeof meta> = { args: { variant: "primary" } };
export const Secondary: StoryObj<typeof meta> = { args: { variant: "secondary" } };
