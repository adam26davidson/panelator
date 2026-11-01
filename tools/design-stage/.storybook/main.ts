import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  // The renderer builds one spec's design/ (DESIGN_STAGE_SPEC_DIR); `pnpm storybook` catalogues every spec's.
  stories: process.env.DESIGN_STAGE_SPEC_DIR
    ? [`${process.env.DESIGN_STAGE_SPEC_DIR}/design/*.stories.tsx`]
    : ["../../../specs/*/design/*.stories.tsx", "../test/fixtures/specs/*/design/*.stories.tsx"],
  addons: [],
  core: { disableTelemetry: true },
  async viteFinal(viteConfig) {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()];
    return viteConfig;
  },
};

export default config;
