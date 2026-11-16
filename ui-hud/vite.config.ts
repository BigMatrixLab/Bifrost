import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The demo backend is shared with the main app (../mock); it is only read.
const mockFile = (f: string) => fileURLToPath(new URL(`../mock/${f}`, import.meta.url));

export default defineConfig(({ mode }) => {
  const mock = mode === "mock" || process.env.RL_MOCK === "1";
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    clearScreen: false,
    // Its own port, so it can run next to the main UI's dev server (5173).
    server: { port: 5174, strictPort: true, fs: { allow: [".."] } },
    build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900, outDir: "dist", emptyOutDir: true },
    resolve: mock
      ? {
          alias: {
            "@tauri-apps/api/core": mockFile("core.ts"),
            "@tauri-apps/api/event": mockFile("event.ts"),
            "@tauri-apps/plugin-dialog": mockFile("plugins.ts"),
            "@tauri-apps/plugin-autostart": mockFile("plugins.ts"),
          },
        }
      : {},
  };
});
