import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { FreshnessBanner, FreshnessChip } from "../../features/freshness/Freshness.tsx";
import { SignIn, SignInRefused } from "../../pages/sign-in/SignIn.tsx";
import type { ConsoleState } from "../../shared/api/types.ts";
import { Rail, SCREENS, type ScreenName, TabBar } from "../../widgets/nav/nav.tsx";
import { useConsole } from "../ConsoleProvider.tsx";

/** The shell of every signed-in screen: the rail from 720px, the tab bar below it, a header with the freshness chip. */
function Shell({ screen, narrow, children }: { screen: ScreenName; narrow?: boolean; children: ReactNode }) {
  const { login, clearResolved } = useConsole();
  const [sheet, setSheet] = useState(false);
  const { logout } = useConsole();
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Leaving a screen clears the refusals it showed.
  useEffect(() => clearResolved, [path]);
  return (
    <div className="c-root">
      <Rail login={login} />
      <main className="c-main">
        <div className={`c-inner${narrow ? " c-narrow" : ""}`}>
          <header className="c-header">
            <h1>{label}</h1>
            <div className="c-header-end">
              <FreshnessChip />
              <button
                type="button"
                className="c-avatar"
                aria-label={`Account: @${login}`}
                aria-expanded={sheet}
                onClick={() => setSheet(!sheet)}
              >
                {login.slice(0, 1).toUpperCase()}
              </button>
            </div>
          </header>
          {sheet ? (
            <div className="c-card c-account" role="dialog" aria-label="Account">
              <span className="c-muted">Signed in as</span>
              <span className="c-strong">@{login}</span>
              <button type="button" className="c-btn" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          ) : null}
          <FreshnessBanner />
          {children}
        </div>
      </main>
      <TabBar />
    </div>
  );
}

/**
 * Gates a screen on the console's state: signed out leads to sign-in naming the screen, loading shows the shell with skeleton
 * blocks, and a snapshot renders the screen (spec 051 AC-14).
 */
export function Screen({
  screen,
  narrow,
  skeleton,
  children,
}: {
  screen: ScreenName;
  narrow?: boolean;
  skeleton: ReactNode;
  children: (s: ConsoleState, now: number) => ReactNode;
}) {
  const { view } = useConsole();
  const loc = useRouterState({ select: (s) => s.location });
  if (view.status === "signed-out") {
    const refused = new URLSearchParams(loc.searchStr).get("refused");
    if (refused !== null) return <SignInRefused login={refused || undefined} />;
    return <SignIn screen={screen} returnTo={loc.pathname} />;
  }
  return (
    <Shell screen={screen} narrow={narrow}>
      {view.status === "ready" ? children(view.snapshot, view.now) : skeleton}
    </Shell>
  );
}
