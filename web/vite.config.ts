import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Keep the browser's Host: the API refuses writes whose Origin doesn't match it.
    proxy: { "/api": { target: "http://127.0.0.1:4471", changeOrigin: false } },
  },
});
