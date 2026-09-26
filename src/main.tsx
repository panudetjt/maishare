import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles/global.css";

// StrictMode is omitted on purpose: double-mounted effects would tear down and
// rebuild the WebRTC mesh on every mount in development.
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

// Offline app shell: sw.js (the precache manifest) is generated at build time
// by scripts/pwa-build.mjs. Dev never registers — there is no sw.js there.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
