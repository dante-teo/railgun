import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/markdown.css";
import { applyTheme, getInitialTheme, subscribeThemeChanges } from "./lib/theme.js";
import { App } from "./components/App.js";
import { DevShell } from "./components/DevShell.js";

// Apply theme before first paint
const initialTheme = getInitialTheme();
applyTheme(initialTheme);
subscribeThemeChanges(applyTheme);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No #root element");

const root = createRoot(rootEl);
root.render(
  <React.StrictMode>
    {import.meta.env.DEV ? <DevShell /> : <App />}
  </React.StrictMode>,
);
