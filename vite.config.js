import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "client",
  // Relative asset URLs, so the built page works wherever it is mounted. A
  // reverse proxy that serves the app under a path prefix (code-server's port
  // proxy uses /<workspace-id>-<port>/) would otherwise make the browser ask
  // for /assets/... at the proxy root, above the prefix, and get the proxy's
  // own 404 instead of the bundle.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      // The issue catalog is the one module both sides read, so the titles,
      // explanations and fix advice in the UI can't drift from the engine's.
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:31302" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
