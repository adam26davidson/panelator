import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { type ReactNode, useState } from "react";

/** A query client for one app instance or one test: nothing is shared, nothing is retried. */
function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Gives a piece of UI the router and the query client it needs, at any address: for component tests and stories. */
function WithProviders({ children, address = "/" }: { children: ReactNode; address?: string }) {
  const [state] = useState(() => {
    const root = createRootRoute({ component: () => children });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/" })]),
      history: createMemoryHistory({ initialEntries: [address] }),
    });
    return { router, queryClient: makeQueryClient() };
  });
  return (
    <QueryClientProvider client={state.queryClient}>
      <RouterProvider router={state.router} />
    </QueryClientProvider>
  );
}

/** Renders a piece of UI inside `WithProviders`; the router mounts it asynchronously, so assert with `findBy`. */
export function renderUi(ui: ReactNode, address = "/") {
  return render(<WithProviders address={address}>{ui}</WithProviders>);
}
