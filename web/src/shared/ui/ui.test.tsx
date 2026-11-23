import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "@/shared/lib";
import { Button, ButtonLink, Frame, PageHeading, ReadingColumn } from "./index";

describe("Frame", () => {
  it("holds a banner with the name as the link home, and a main region", async () => {
    renderUi(
      <Frame>
        <p>content</p>
      </Frame>,
    );
    const banner = await screen.findByRole("banner");
    const home = within(banner).getByRole("link", { name: "panelator" });
    expect(home.getAttribute("href")).toBe("/");
    expect(within(screen.getByRole("main")).getByText("content")).toBeTruthy();
    expect(banner.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("ReadingColumn", () => {
  it("holds its children in one column", async () => {
    renderUi(
      <ReadingColumn>
        <p>a</p>
        <p>b</p>
      </ReadingColumn>,
    );
    const column = (await screen.findByText("a")).parentElement;
    expect(column?.children).toHaveLength(2);
  });
});

describe("PageHeading", () => {
  it("renders the eyebrow, one focusable h1 and the lead", async () => {
    renderUi(<PageHeading eyebrow="Eyebrow" title="Title" lead="Lead text" />);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Title" });
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByText("Eyebrow").className).toContain("text-muted");
    expect(screen.getByText("Lead text")).toBeTruthy();
  });

  it("colours the eyebrow in the danger tone", async () => {
    renderUi(<PageHeading tone="danger" eyebrow="Eyebrow" title="Title" lead="Lead" />);
    expect((await screen.findByText("Eyebrow")).className).toContain("text-danger");
  });
});

describe("Button and ButtonLink", () => {
  it("renders a button of each look, at least the tap size tall", async () => {
    renderUi(
      <>
        <Button variant="primary">Go</Button>
        <Button variant="secondary">Stop</Button>
      </>,
    );
    expect((await screen.findByRole("button", { name: "Go" })).className).toContain("bg-accent");
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.className).toContain("border-border-strong");
    expect(stop.className).not.toContain("border-transparent");
    expect(stop.className).toContain("min-h-tap");
    expect(stop.getAttribute("type")).toBe("button");
  });

  it("renders a link to a route in the same look", async () => {
    renderUi(
      <ButtonLink variant="primary" to="/">
        Home
      </ButtonLink>,
    );
    const link = await screen.findByRole("link", { name: "Home" });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.className).toContain("min-h-tap");
  });
});
