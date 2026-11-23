import {
  type AnyRoute,
  type AnyRouter,
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Outlet,
  type RouterHistory,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ErrorPage } from "@/pages/error";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
import { Frame } from "@/shared/ui";

// Routers that have shown a screen after their first load: only then does focus move to the new screen's heading.
const navigated = new WeakSet<AnyRouter>();

function focusHeading() {
  document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function Shell() {
  const router = useRouter();
  const key = useRouterState({ select: (s) => s.resolvedLocation?.state.__TSR_key });
  const first = useRef(true);
  useEffect(() => {
    if (key === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    navigated.add(router);
    focusHeading();
  }, [key, router]);
  return (
    <Frame>
      <Outlet />
    </Frame>
  );
}

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => {
    if (navigated.has(router)) focusHeading();
  }, [router]);
  return <ErrorPage error={error} onLeave={reset} />;
}

function makeRoot() {
  return createRootRoute({ component: Shell });
}

function makeHome(root: ReturnType<typeof makeRoot>) {
  return createRoute({ getParentRoute: () => root, path: "/", component: HomePage });
}

const DEFAULTS = { defaultErrorComponent: RouteError, defaultNotFoundComponent: NotFoundPage };

/** The app's router on `history`. A test passes a memory history; the browser passes its own. */
export function createAppRouter(history: RouterHistory) {
  const root = makeRoot();
  return createRouter({ routeTree: root.addChildren([makeHome(root)]), history, ...DEFAULTS });
}

/** The same router with more routes under the root, for tests that need a route that fails. */
export function createAppRouterWith(history: RouterHistory, more: (root: ReturnType<typeof makeRoot>) => AnyRoute[]) {
  const root = makeRoot();
  return createRouter({ routeTree: root.addChildren([makeHome(root), ...more(root)]), history, ...DEFAULTS });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
