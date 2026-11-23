import type { Preview } from "@storybook/react-vite";
import { WithProviders } from "@/shared/lib";
import "../src/app/styles.css";

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <WithProviders>
        <Story />
      </WithProviders>
    ),
  ],
};

export default preview;
