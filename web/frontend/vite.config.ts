import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API + SSE to the FastAPI backend during development. The target is
// overridable (VITE_API_PROXY) so the Docker frontend container can point at
// the `backend` service instead of localhost.
const apiTarget = process.env.VITE_API_PROXY || "http://127.0.0.1:8888";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
