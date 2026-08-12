import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import { initDiagnostics } from "./collab/diagnostics";

import ExcalidrawApp from "./App";

// self-hosted operations aid: window.__EXCALIDRAW_DIAG__ + window.excalidrawDiag()
initDiagnostics();

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
