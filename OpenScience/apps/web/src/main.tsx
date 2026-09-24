import "./lib/polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
// The DOM build of the provider, for one reason: it hands the router
// `ReactDOM.flushSync`, which a navigation asked with `{ flushSync: true }`
// needs. A project switch uses it to render the new project and the page it
// lands on together (`useProjectStore.select`); every other navigation is
// unchanged.
import { RouterProvider } from "react-router/dom";
import { ThemeProvider } from "./app/providers/ThemeProvider";
import { router } from "./app/router";
import { installStaleChunkReload } from "./lib/staleChunk";
import "./index.css";

// Before the first page chunk is asked for: a tab older than the release it
// talks to reloads once instead of failing the page (UI plan §2.1).
installStaleChunkReload();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </React.StrictMode>,
);
