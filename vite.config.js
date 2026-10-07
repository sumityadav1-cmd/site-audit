import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "client",
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
    proxy: { "/api": "http://localhost:3001" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
