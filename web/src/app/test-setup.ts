import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement scrolling; the app scrolls to the top after a navigation.
window.scrollTo = () => undefined;
