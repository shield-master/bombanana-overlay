import { defineConfig } from "vite";

// Tauri + Windows only: WebView2 is evergreen Chromium, so we can target modern JS.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "chrome120", minify: "esbuild", sourcemap: false },
});
