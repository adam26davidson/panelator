// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignInRefused } from "../src/pages/sign-in/SignIn.tsx";
import { emptySnapshot, snapshot } from "./fixtures.ts";
import { makeNet, mount } from "./harness.tsx";

afterEach(cleanup);

const heading = async (name: string, loading = false) => {
  const h = await screen.findByRole("heading", { level: 1, name });
  if (loading) return h;
  // The skeleton of each screen is aria-busy until the first answer from the handlers arrives.
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
  return h;
};

const SCREENS = [
  { path: "/", title: "Home", empty: /Nothing is running/, data: /Event store retention and compaction/ },
  { path: "/questions", title: "Questions", empty: /No questions/, data: /Should a widget fetch/ },
  { path: "/history", title: "History", empty: /No metrics report yet/, data: /merged per week/ },
  { path: "/actions", title: "Actions", empty: /No actions yet/, data: /Set slots to 2/ },
  { path: "/agents", title: "Agents", empty: /No standing agents/, data: /findings-filer/ },
  { path: "/parameters", title: "Parameters", empty: /No parameters/, data: /aws_cap_usd/ },
];

describe.each(SCREENS)("$title: every state", ({ path, title, empty, data }) => {
  it("default shows the data", async () => {
    mount(path, makeNet());
    await heading(title);
    expect((await screen.findAllByText(data)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Updated 18 s ago/)).toBeTruthy();
  });
  it("loading shows the shell with skeleton blocks", async () => {
    const { container } = mount(path, makeNet({ hang: true }));
    await heading(title, true);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getByText("Loading")).toBeTruthy();
  });
  it("stale marks the snapshot older than three ticks", async () => {
    mount(path, makeNet({ ageS: 600 }));
    expect(await screen.findByText(/Stale · 10 min old/)).toBeTruthy();
    expect(screen.getByText(/This snapshot is 10 minutes old/)).toBeTruthy();
  });
  it("unreachable keeps the last snapshot and says so", async () => {
    const net = makeNet();
    mount(path, net);
    await screen.findAllByText(data);
    net.failing = true;
    expect(await screen.findByText("Can't reach the console API")).toBeTruthy();
    expect(screen.getAllByText(data).length).toBeGreaterThan(0);
    expect(screen.getByText(/Offline ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
  });
  it("signed out leads to sign-in naming the screen", async () => {
    mount(path, makeNet({ unauthorized: true }));
    expect(await screen.findByText(`Sign in to see ${title}`)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Sign in with GitHub/ }).getAttribute("href")).toMatch(
      /^\/auth\/login\?return=/,
    );
    expect(screen.getByText(`After sign-in you return to ${title}.`)).toBeTruthy();
  });
  it("empty explains itself", async () => {
    mount(path, makeNet({ snapshot: emptySnapshot }));
    expect(await screen.findByText(empty)).toBeTruthy();
  });
});

describe("sign-in refused", () => {
  it("names the refused account and offers another", () => {
    render(<SignInRefused login="someone-else" />);
    expect(screen.getByText("This login can't use the console")).toBeTruthy();
    expect(screen.getByText("@someone-else")).toBeTruthy();
    expect(screen.getByRole("link", { name: /different GitHub account/ })).toBeTruthy();
  });
});

describe("sign-in transitions", () => {
  it("a signed-out visitor sees the refusal card at /sign-in-refused", async () => {
    mount("/sign-in-refused?login=someone-else", makeNet({ unauthorized: true }));
    expect(await screen.findByText("@someone-else")).toBeTruthy();
  });
  it("the sign-in link carries the screen that was opened", async () => {
    mount("/questions", makeNet({ unauthorized: true }));
    const a = await screen.findByRole("link", { name: /Sign in with GitHub/ });
    expect(a.getAttribute("href")).toBe("/auth/login?return=%2Fquestions");
  });
});

describe("shell and navigation", () => {
  it("has the rail and the tab bar, marks the current screen and counts open questions", async () => {
    mount("/questions", makeNet());
    await heading("Questions");
    const links = screen.getAllByRole("link", { name: /Questions/ });
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.getAttribute("aria-current")).toBe("page");
      expect(within(l).getByText("2")).toBeTruthy();
    }
    for (const nav of screen.getAllByRole("navigation")) expect(within(nav).getAllByRole("link")).toHaveLength(6);
    expect(screen.getAllByRole("link", { name: /^Home/ })[0].getAttribute("aria-current")).toBeNull();
  });
  it("navigates between screens", async () => {
    mount("/", makeNet());
    await heading("Home");
    fireEvent.click(screen.getAllByRole("link", { name: /^Agents/ })[0]);
    await heading("Agents");
  });
  it("shows the signed-in login, the account sheet and signs out", async () => {
    const net = makeNet();
    mount("/", net);
    await heading("Home");
    expect(screen.getAllByText("@maintainer").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Account: @maintainer" }));
    expect(screen.getByRole("dialog", { name: "Account" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign in to see Home");
    expect(net.loggedOut).toBe(true);
  });
  it("signing out on another screen leads to the sign-in card for Home", async () => {
    mount("/parameters", makeNet());
    await heading("Parameters");
    fireEvent.click(screen.getByRole("button", { name: "Account: @maintainer" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign in to see Home");
  });
});

describe("Home", () => {
  it("shows banner, the oldest claim large, others compact, three up next, four tiles", async () => {
    mount("/", makeNet());
    await heading("Home");
    const banner = screen.getByRole("link", { name: /2 open questions for you/ });
    expect(banner.getAttribute("href")).toBe("/questions");
    expect(screen.getByRole("link", { name: /PR #205/ }).getAttribute("href")).toBe(
      "https://github.com/adam26davidson/panelator/pull/205",
    );
    const card = screen.getByLabelText("Running now");
    expect(within(card).getByText("claude-opus-5-5")).toBeTruthy();
    expect(within(card).getByText("$3.18")).toBeTruthy();
    expect(
      within(screen.getByLabelText("Also running")).getByText(/Specify and build the maintainer console/),
    ).toBeTruthy();
    const next = screen.getByLabelText("Up next");
    expect(within(next).getAllByRole("listitem")).toHaveLength(3);
    expect(within(next).queryByText(/Telegram reminders/)).toBeNull();
    const tile = screen.getByRole("link", { name: /Merged per week/ });
    expect(tile.getAttribute("href")).toBe("/history?metric=merged_per_week");
    expect(within(tile).getByText("9")).toBeTruthy();
    expect(screen.getByRole("link", { name: /AWS spend/ }).getAttribute("href")).toBe("/parameters?focus=aws_cap_usd");
    expect(screen.getByText("of $5 cap")).toBeTruthy();
  });
  it("idle shows the next tick and, with no data, 'No data' tiles and the cap-0 line", async () => {
    mount("/", makeNet({ snapshot: emptySnapshot }));
    await screen.findByText("Nothing is running");
    expect(screen.getByText(/next tick is at 10:46/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /open questions/ })).toBeNull();
    expect(screen.getAllByText("No data").length).toBe(3);
    expect(screen.getByText("cap 0: nothing may be launched")).toBeTruthy();
    expect(screen.getByText("No issue is ready. The shortlist is empty.")).toBeTruthy();
  });
  it("a tile opens History at its metric, outlined", async () => {
    mount("/", makeNet());
    await heading("Home");
    fireEvent.click(screen.getByRole("link", { name: /Median issue-to-merge/ }));
    await heading("History");
    await waitFor(() => expect(document.getElementById("history-issue_to_merge_days")?.className).toContain("c-focus"));
  });
});

describe("Questions", () => {
  it("lists open first with GitHub and Telegram links, then answered with the decision record", async () => {
    mount("/questions", makeNet());
    await screen.findByText("Open · 2");
    const open = screen.getByLabelText("Open");
    expect(
      within(open)
        .getAllByRole("link", { name: /Answer on GitHub/ })[0]
        .getAttribute("href"),
    ).toContain("#issuecomment-3012");
    expect(
      within(open)
        .getAllByRole("link", { name: /Open Telegram chat/ })[0]
        .getAttribute("href"),
    ).toBe("https://t.me/panel_bot");
    expect(within(open).getByText("Reminded")).toBeTruthy();
    const done = screen.getByLabelText("Answered");
    expect(
      within(done)
        .getByRole("link", { name: /Decision record/ })
        .getAttribute("href"),
    ).toContain("#issuecomment-2952");
  });
  it("omits the Telegram link without telegram_url", async () => {
    const qs = snapshot.questions.map(({ telegram_url: _t, ...q }) => q);
    mount("/questions", makeNet({ snapshot: { ...snapshot, questions: qs } }));
    await screen.findByText("Open · 2");
    expect(screen.queryByRole("link", { name: /Telegram/ })).toBeNull();
  });
});

describe("History", () => {
  it("draws every metric, selectable window, gaps as gaps, a replaced metric beside its replacement", async () => {
    mount("/history", makeNet());
    await heading("History");
    expect(screen.getByRole("button", { name: "12 wk", pressed: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "merged per week" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^claude cost per merge/ })).toBeNull();
    expect(screen.getByText("(replaced)")).toBeTruthy();
    expect(screen.getByText(/Replaced on 13 Oct/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "4 wk" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "4 wk", pressed: true })).toBeTruthy());
    const card = document.getElementById("history-merged_per_week") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Table" }));
    expect(within(card).getAllByRole("row")).toHaveLength(5);
  });
  it("a null bucket is no data in the table, never a zero", async () => {
    mount("/history", makeNet());
    await heading("History");
    const card = document.getElementById("history-merged_per_week") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Table" }));
    expect(within(card).getAllByText("no data")).toHaveLength(1);
    expect(within(card).getByText(/Gap: no events in the week of/)).toBeTruthy();
  });
  it("opening from a tile outlines that card", async () => {
    mount("/history?metric=issue_to_merge_days", makeNet());
    await heading("History");
    await waitFor(() => expect(document.getElementById("history-issue_to_merge_days")?.className).toContain("c-focus"));
  });
});

describe("Actions", () => {
  it("lists newest first, with Undo only on applied entries that can be undone", async () => {
    mount("/actions", makeNet());
    await heading("Actions");
    // Each row renders its control in the narrow block and in the wide cell; CSS shows one of them.
    expect(screen.getAllByRole("button", { name: /^Undo:/ })).toHaveLength(4);
    expect(screen.getAllByText("you (maintainer)").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/aws_cap_usd is locked/).length).toBeGreaterThan(0);
  });
  it("posts an undo, shows it pending, then the refusal", async () => {
    const net = makeNet();
    mount("/actions", net);
    await heading("Actions");
    fireEvent.click(screen.getAllByRole("button", { name: /^Undo: Set slots to 2/ })[0]);
    await waitFor(() => expect(net.posts).toEqual([{ kind: "undo", args: { action_id: "a-0193" } }]));
    expect((await screen.findAllByText("Undo pending")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Undo sent as change 1/)).toBeTruthy();
    expect(screen.getAllByText("Undoing…")[0].closest("button")?.hasAttribute("disabled")).toBe(true);
    net.settle({ id: 1, status: "refused", reason: "slots was changed again" });
    expect(await screen.findByText("Undo refused: slots was changed again")).toBeTruthy();
  });
});

describe("Agents", () => {
  it("says who paused, offers Resume on paused and Pause on running", async () => {
    mount("/agents", makeNet());
    await heading("Agents");
    expect(screen.getAllByText("Paused by you").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Paused by findings-filer").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Resume/ }).length).toBeGreaterThan(0);
  });
  it("posts a pause, shows it pending, and a refusal with its reason", async () => {
    const net = makeNet();
    mount("/agents", net);
    await heading("Agents");
    fireEvent.click(screen.getAllByRole("button", { name: /Pause$/ })[0]);
    await waitFor(() => expect(net.posts).toEqual([{ kind: "pause_agent", args: { name: "findings-filer" } }]));
    expect((await screen.findAllByRole("button", { name: "Pausing…" })).length).toBeGreaterThan(0);
    expect(screen.getByText(/Pause sent as change 1/)).toBeTruthy();
    net.settle({ id: 1, status: "refused", reason: "agent is not in the registry" });
    expect(await screen.findByText(/Pause refused: agent is not in the registry/)).toBeTruthy();
  });
});

describe("Parameters", () => {
  it("shows limits, the switch and the locked note", async () => {
    mount("/parameters", makeNet());
    await heading("Parameters");
    expect(screen.getAllByText("min 1 · max 4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Locked: the system cannot change this. You can.").length).toBe(2);
    expect(screen.getByRole("group", { name: "aws_cap_usd mode" })).toBeTruthy();
  });
  it("a value edit posts set_parameter on Save, pending until the outcome, a refusal keeps the reason", async () => {
    const net = makeNet();
    mount("/parameters", net);
    await heading("Parameters");
    const input = screen.getByLabelText("slots value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(net.posts).toEqual([{ kind: "set_parameter", args: { name: "slots", value: 6 } }]));
    expect(await screen.findByText(/Set to 6, sent as change 1/)).toBeTruthy();
    expect((screen.getByLabelText("slots value") as HTMLInputElement).readOnly).toBe(true);
    net.settle({ id: 1, status: "refused", reason: "slots: out of range" });
    expect(await screen.findByText("Refused: slots: out of range. The value stays 2.")).toBeTruthy();
  });
  it("Enter saves and Escape restores", async () => {
    const net = makeNet();
    mount("/parameters", net);
    await heading("Parameters");
    const input = screen.getByLabelText("slots value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((screen.getByLabelText("slots value") as HTMLInputElement).value).toBe("2");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(net.posts).toHaveLength(1));
  });
  it("the mode switch posts set_parameter_mode at once, booleans post at once", async () => {
    const net = makeNet();
    mount("/parameters", net);
    await heading("Parameters");
    fireEvent.click(
      within(screen.getByRole("group", { name: "aws_cap_usd mode" })).getByRole("button", { name: "Auto" }),
    );
    await waitFor(() =>
      expect(net.posts[0]).toEqual({ kind: "set_parameter_mode", args: { name: "aws_cap_usd", mode: "auto" } }),
    );
    expect(await screen.findByText(/Mode set to auto, sent as change 1/)).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("group", { name: "first_contact_needs_approval value" })).getByRole("button", {
        name: "Off",
      }),
    );
    await waitFor(() =>
      expect(net.posts[1]).toEqual({
        kind: "set_parameter",
        args: { name: "first_contact_needs_approval", value: false },
      }),
    );
  });
  it("opened from the AWS tile it focuses aws_cap_usd", async () => {
    mount("/parameters?focus=aws_cap_usd", makeNet());
    await heading("Parameters");
    await waitFor(() => expect(document.getElementById("parameters-aws_cap_usd")?.className).toContain("c-focus"));
    expect(document.activeElement).toBe(screen.getByLabelText("aws_cap_usd value"));
  });
  it("controls that post changes are disabled while the API is unreachable", async () => {
    const net = makeNet();
    mount("/parameters", net);
    await heading("Parameters");
    net.failing = true;
    await screen.findByText("Can't reach the console API");
    expect((screen.getByLabelText("slots value") as HTMLInputElement).readOnly).toBe(true);
    expect(
      within(screen.getByRole("group", { name: "slots mode" }))
        .getByRole("button", { name: "Auto" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
