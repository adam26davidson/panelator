import { createRoute } from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/shared/lib";
import { createAppRouter, createAppRouterWith } from "./router";

const SECRET = "secret-message-from-the-route";

function failingRoutes(kind: "component" | "loader") {
  return (root: Parameters<Parameters<typeof createAppRouterWith>[1]>[0]) => [
    createRoute({
      getParentRoute: () => root,
      path: "/boom",
      loader: () => {
        if (kind === "loader") throw new Error(SECRET);
      },
      component: () => {
        if (kind === "component") throw new Error(SECRET);
        return <p>unreachable</p>;
      },
    }),
  ];
}

afterEach(() => vi.restoreAllMocks());

describe("Home", () => {
  it("shows the frame and the product statement at /", async () => {
    await renderApp(createAppRouter, "/");
    const banner = await screen.findByRole("banner");
    expect(within(banner).getByRole("link", { name: "panelator" }).getAttribute("href")).toBe("/");
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(main).getByRole("heading", { level: 1 }).textContent).toBe("An LED dashboard you configure yourself");
    expect(within(main).getByText("Open-source LED dashboard")).toBeTruthy();
    expect(
      within(main)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["The panel", "The web app", "Open source"]);
    expect(within(main).getByText("Under construction.")).toBeTruthy();
    expect(within(main).getByText(/The simulator page runs the runtime spike's three widgets/)).toBeTruthy();
    expect(
      within(main)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([["Open the simulator", "/simulator"]]);
    expect(within(main).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await waitFor(() => expect(document.title).toBe("panelator"));
  });

  it("leaves focus alone on a first load", async () => {
    await renderApp(createAppRouter, "/");
    await screen.findByRole("banner");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("Not found", () => {
  it("shows the page inside the frame at an unknown address", async () => {
    const { router } = await renderApp(createAppRouter, "/no/such/place");
    const h1 = await screen.findByRole("heading", { level: 1, name: "Page not found" });
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(within(screen.getByRole("main")).getByText(/This address leads nowhere/)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/no/such/place");
    expect(h1).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Page not found · panelator"));
  });

  it("leads back to Home by the router, moving focus to the heading", async () => {
    await renderApp(createAppRouter, "/no/such/place");
    await userEvent.click(await screen.findByRole("link", { name: "Go to the home page" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "An LED dashboard you configure yourself" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(document.title).toBe("panelator");
  });
});

describe("Error", () => {
  for (const kind of ["component", "loader"] as const) {
    it(`replaces a route whose ${kind} throws, inside the frame, without its message`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { container } = await renderApp((h) => createAppRouterWith(h, failingRoutes(kind)), "/boom");
      await screen.findByRole("heading", { level: 1, name: "Something went wrong" });
      expect(screen.getByRole("banner")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reload the page" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Go to the home page" })).toBeTruthy();
      expect(container.textContent).not.toContain(SECRET);
      expect(container.textContent).not.toMatch(/\bat \w+.*\.tsx?/);
      expect(log.mock.calls.flat().some((a) => a instanceof Error && a.message === SECRET)).toBe(true);
      await waitFor(() => expect(document.title).toBe("Something went wrong · panelator"));
    });
  }

  it("reloads the page by the button", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await renderApp((h) => createAppRouterWith(h, failingRoutes("component")), "/boom");
    await userEvent.click(await screen.findByRole("button", { name: "Reload the page" }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("moves focus to the heading when it replaces a route after a navigation, and the link home clears it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { router } = await renderApp((h) => createAppRouterWith(h, failingRoutes("component")), "/");
    await screen.findByRole("heading", { level: 1, name: "An LED dashboard you configure yourself" });
    router.history.push("/boom");
    const h1 = await screen.findByRole("heading", { level: 1, name: "Something went wrong" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    await userEvent.click(screen.getByRole("link", { name: "Go to the home page" }));
    await screen.findByRole("heading", { level: 1, name: "An LED dashboard you configure yourself" });
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
