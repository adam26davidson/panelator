import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import * as preview from "../../.storybook/preview";

// Every story of the package renders through Storybook's portable stories, so a story cannot rot between catalogue
// builds. A new story file is picked up by the glob.
setProjectAnnotations(preview.default);

const files = import.meta.glob<Record<string, unknown>>("../**/*.stories.tsx", { eager: true });

describe("the stories", () => {
  it("finds the stories of the pages and of every shared/ui component", () => {
    const names = Object.keys(files).map((f) => f.split("/").pop());
    expect(names).toEqual(
      expect.arrayContaining([
        "HomePage.stories.tsx",
        "NotFoundPage.stories.tsx",
        "ErrorPage.stories.tsx",
        "Frame.stories.tsx",
        "ReadingColumn.stories.tsx",
        "PageHeading.stories.tsx",
        "Button.stories.tsx",
        "ButtonLink.stories.tsx",
      ]),
    );
  });

  for (const [file, module] of Object.entries(files)) {
    // biome-ignore lint/suspicious/noExplicitAny: composeStories takes any CSF module
    const stories = composeStories(module as any) as Record<string, ComponentType>;
    for (const [name, Story] of Object.entries(stories)) {
      it(`renders ${file.split("/").pop()} ${name}`, async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { container } = render(<Story />);
        await waitFor(() => expect(container.textContent).not.toBe(""));
        expect(screen.queryByText(/Error:/)).toBeNull();
        expect(container.querySelector("[data-story-error]")).toBeNull();
      });
    }
  }
});
