import { defineConfig } from "vite";

// Tauri + Windows only: WebView2 is evergreen Chromium, so we can target modern JS.
export default defineConfig({
  clearScreen: false,
  server: {
    // Строго IPv4: по умолчанию vite садится на localhost, который на Windows
    // разрешается в ::1, а Tauri CLI ждёт дев-сервер на 127.0.0.1 и не дожидается.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Следить за target/ нельзя: там гигабайты артефактов, а залоченную
    // компилятором .dll вотчер роняет с EBUSY.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "chrome120", minify: "esbuild", sourcemap: false },
});
