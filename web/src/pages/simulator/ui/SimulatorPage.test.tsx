import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/shared/lib";
import { SimulatorPage } from "./SimulatorPage";

describe("SimulatorPage", () => {
  it("shows failed with the file's name when a file cannot be fetched, and loads again on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("spike-clock.wasm") ? new Response("no", { status: 503 }) : new Response(new Uint8Array(8)),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderUi(<SimulatorPage />);
    expect((await screen.findByRole("status")).textContent).toBe("Loading the simulator…");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("spike-clock.wasm: could not be fetched (503)");
    const calls = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Load the simulator again" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
    await screen.findByRole("alert");
    vi.unstubAllGlobals();
  });
  it("reports a network error in the same words", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    renderUi(<SimulatorPage />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/: could not be fetched \(offline\)/));
    vi.unstubAllGlobals();
  });
});
