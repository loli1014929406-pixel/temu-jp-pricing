import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/yamato-tracking": {
        target: "https://toi.kuronekoyamato.co.jp",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/yamato-tracking/, ""),
      },
    },
  },
});
