import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";
import type { InlineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const designDir = process.env.PANELATOR_DESIGN_DIR;

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: designDir
    ? [{ directory: designDir, files: "*.stories.tsx", titlePrefix: "" }]
    : ["../../../specs/*/design/*.stories.tsx", "../test/fixtures/specs/*/design/*.stories.tsx"],
  addons: [],
  core: { disableTelemetry: true },
  async viteFinal(base: InlineConfig): Promise<InlineConfig> {
    // A story under a temporary directory cannot resolve bare imports from where it lives.
    // Exact matches: a plain "react" key would also rewrite "react/jsx-runtime".
    const alias = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"].map((id) => ({
      find: new RegExp(`^${id}$`),
      replacement: require.resolve(id),
    }));
    const allow = [join(here, ".."), join(here, "..", "..", "..")];
    if (designDir) allow.push(designDir);
    return {
      ...base,
      plugins: [...(base.plugins ?? []), tailwindcss()],
      resolve: { ...base.resolve, alias },
      server: { ...base.server, fs: { ...base.server?.fs, allow } },
    };
  },
};

export default config;
