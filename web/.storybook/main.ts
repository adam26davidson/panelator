import type { StorybookConfig } from "@storybook/react-vite";

// The package's own vite.config.ts supplies React, Tailwind and the `@/` alias.
const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: [],
  core: { disableTelemetry: true },
};

export default config;
