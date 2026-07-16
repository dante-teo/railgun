import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateCheckPage } from "./UpdateCheckPage";
import "overlayscrollbars/overlayscrollbars.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing renderer root element");

const surface = new URLSearchParams(window.location.search).get("surface");
document.documentElement.dataset.rendererSurface = surface ?? "app";

createRoot(root).render(
  <StrictMode>
    {surface === "update-check" ? <UpdateCheckPage /> : <App />}
  </StrictMode>,
);
