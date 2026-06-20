import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function normalizeModuleId(id: string) {
  return id.replace(/\\/g, "/");
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = normalizeModuleId(id);

          if (normalizedId.includes("/node_modules/react/") || normalizedId.includes("/node_modules/react-dom/")) {
            return "react";
          }
          if (normalizedId.includes("/node_modules/@supabase/supabase-js/")) {
            return "supabase";
          }
          if (normalizedId.includes("/node_modules/react-router-dom/")) {
            return "router";
          }
          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "lucide";
          }
          if (normalizedId.includes("/node_modules/read-excel-file/") || normalizedId.includes("/node_modules/write-excel-file/")) {
            return "excel";
          }
          if (normalizedId.endsWith("/src/hooks/useOrders.ts")) {
            return "orders-hook";
          }

          const pageMatch = normalizedId.match(/\/src\/pages\/([^/]+)\.tsx$/);
          if (pageMatch) {
            return pageMatch[1];
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/yamato-tracking": {
        target: "https://toi.kuronekoyamato.co.jp",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/yamato-tracking/, ""),
      },
      "/japanpost-tracking": {
        target: "https://trackings.post.japanpost.jp",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/japanpost-tracking/, ""),
      },
    },
  },
});
