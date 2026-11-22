import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useConsole } from "../../app/ConsoleProvider.tsx";
import { Icon } from "../../shared/ui/Icon.tsx";

export type ScreenName = "home" | "questions" | "history" | "actions" | "agents" | "parameters";

export const SCREENS: { id: ScreenName; label: string; short: string; to: string }[] = [
  { id: "home", label: "Home", short: "Home", to: "/" },
  { id: "questions", label: "Questions", short: "Questions", to: "/questions" },
  { id: "history", label: "History", short: "History", to: "/history" },
  { id: "actions", label: "Actions", short: "Actions", to: "/actions" },
  { id: "agents", label: "Agents", short: "Agents", to: "/agents" },
  { id: "parameters", label: "Parameters", short: "Params", to: "/parameters" },
];

const ICON: Record<ScreenName, (s?: number) => ReactNode> = {
  home: Icon.home,
  questions: Icon.question,
  history: Icon.chart,
  actions: Icon.list,
  agents: Icon.bot,
  parameters: Icon.sliders,
};

function useOpenQuestions(): number {
  const { view } = useConsole();
  return view.status === "ready" ? view.snapshot.questions.filter((q) => q.status !== "answered").length : 0;
}

/** The side rail from 720px: the six screens, the open-question count, and at its foot the login and Sign out. */
export function Rail({ login }: { login: string }) {
  const { logout } = useConsole();
  const navigate = useNavigate();
  const open = useOpenQuestions();
  return (
    <nav className="c-rail" aria-label="Console">
      <div className="c-rail-inner">
        <div className="c-brand">
          panelator<span>maintainer console</span>
        </div>
        {SCREENS.map((s) => (
          <Link
            key={s.id}
            className="c-nav"
            to={s.to}
            activeOptions={{ exact: true }}
            activeProps={{ "aria-current": "page" }}
          >
            {s.label}
            {s.id === "questions" && open > 0 ? <span className="c-count">{open}</span> : null}
          </Link>
        ))}
        <div className="c-rail-foot">
          <span className="c-muted">Signed in as</span>
          <span className="c-strong">@{login}</span>
          <button
            type="button"
            className="c-btn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => void logout(() => void navigate({ to: "/" }))}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

/** The bottom tab bar below 720px: six tabs, the open-question count on Questions. */
export function TabBar() {
  const open = useOpenQuestions();
  return (
    <nav className="c-tabs" aria-label="Console tabs">
      {SCREENS.map((s) => (
        <Link
          key={s.id}
          className="c-tab"
          to={s.to}
          activeOptions={{ exact: true }}
          activeProps={{ "aria-current": "page" }}
        >
          <span className="c-tab-icon">
            {ICON[s.id](22)}
            {s.id === "questions" && open > 0 ? <span className="c-count">{open}</span> : null}
          </span>
          {s.short}
        </Link>
      ))}
    </nav>
  );
}
