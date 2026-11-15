import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StoreProvider } from "./store";
import { FlowProvider } from "./flow";
import "@fontsource-variable/space-grotesk";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/share-tech-mono/400.css";
import "./styles.css";
// The glass HUD design goes last: it restyles everything above for the new layout.
import "./glass.css";
import { applyTheme } from "./theme";

applyTheme();

// Desktop app: no browser context menu or accidental reloads.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});
// Reload stays available in development (npm run dev:ui / tauri dev).
window.addEventListener("keydown", (e) => {
  if (import.meta.env.DEV) return;
  if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <FlowProvider>
        <App />
      </FlowProvider>
    </StoreProvider>
  </StrictMode>,
);
