import fsd from "@feature-sliced/steiger-plugin";
import { defineConfig } from "steiger";

// The recommended rule set, with nothing switched off. A rule may be switched off here only when the skeleton's size
// alone trips it (for example a slice with a single consumer), with the reason beside it (spec 112 AC-3).
export default defineConfig([...fsd.configs.recommended]);
