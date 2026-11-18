import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:8787", changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: a dashboard deploy doesn't make users re-download these.
        manualChunks: (id) => (id.includes("node_modules/viem") || id.includes("node_modules/@noble") || id.includes("node_modules/ox") || id.includes("node_modules/abitype") ? "viem" : id.includes("node_modules/react") ? "react" : undefined),
      },
    },
  },
});
