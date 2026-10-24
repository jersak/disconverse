import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // AudioWorklet modules must be real files; data: URLs aren't reliably loadable as worklets.
    assetsInlineLimit: (file) => (file.includes("workletProcessor") ? false : undefined),
  },
  server: {
    port: 5173,
    strictPort: true, // the server only accepts WebSockets from http://localhost:5173
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", ws: true },
    },
  },
});
