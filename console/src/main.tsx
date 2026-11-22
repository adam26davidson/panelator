import { createBrowserHistory } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "./app/styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App history={createBrowserHistory()} />);
