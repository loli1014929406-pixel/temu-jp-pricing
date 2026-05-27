import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ocs-tracking": {
        target: "https://webcsw.ocs.co.jp",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/ocs-tracking/, ""),
      },
    },
  },
});
