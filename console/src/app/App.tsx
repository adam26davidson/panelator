import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { Actions } from "../pages/actions/Actions.tsx";
import { Agents } from "../pages/agents/Agents.tsx";
import { History } from "../pages/history/History.tsx";
import { Home } from "../pages/home/Home.tsx";
import { Parameters } from "../pages/parameters/Parameters.tsx";
import { Questions } from "../pages/questions/Questions.tsx";
import { type Api, makeApi } from "../shared/api/client.ts";
import { ConsoleProvider } from "./ConsoleProvider.tsx";

const root = createRootRoute({ component: Outlet });
const path = (
  to: string,
  component: () => React.JSX.Element,
  validateSearch?: (s: Record<string, unknown>) => Record<string, unknown>,
) => createRoute({ getParentRoute: () => root, path: to, component, validateSearch });

const routeTree = root.addChildren([
  path("/", Home),
  path("/questions", Questions),
  path("/history", History, (s) => ({
    ...(s.weeks !== undefined ? { weeks: Number(s.weeks) } : {}),
    ...(typeof s.metric === "string" ? { metric: s.metric } : {}),
  })),
  path("/actions", Actions),
  path("/agents", Agents),
  path("/parameters", Parameters, (s) => (typeof s.focus === "string" ? { focus: s.focus } : {})),
]);

export function App({
  history,
  api,
  nowFn,
  pollMs,
}: {
  history: RouterHistory;
  api?: Api;
  nowFn?: () => number;
  pollMs?: number;
}) {
  const client = useMemo(() => new QueryClient(), []);
  const router = useMemo(() => createRouter({ routeTree, history }), [history]);
  const a = useMemo(() => api ?? makeApi(), [api]);
  return (
    <QueryClientProvider client={client}>
      <ConsoleProvider api={a} nowFn={nowFn} pollMs={pollMs}>
        <RouterProvider router={router} />
      </ConsoleProvider>
    </QueryClientProvider>
  );
}
