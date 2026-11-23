import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./router";
import "./styles.css";

const router = createAppRouter(createBrowserHistory());
const queryClient = new QueryClient();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
