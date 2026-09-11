import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const rootDir = fileURLToPath(new URL(".", import.meta.url))

const apiProxy = {
  "/api": {
    target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787",
    changeOrigin: true,
  },
}

const usePolling = process.env.CHOKIDAR_USEPOLLING === "true"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: apiProxy,
    ...(usePolling ? { watch: { usePolling: true } } : {}),
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
