import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environmentOptions: {
      jsdom: {
        // canvas als optional dep deaktivieren — libuuid fehlt im Replit-Container
        resources: "usable",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // canvas benötigt libuuid (Systemlib) → Stub umleiten, verhindert DLOPEN-Absturz
      "canvas": path.resolve(__dirname, "./src/test/canvas-mock.ts"),
    },
  },
});
