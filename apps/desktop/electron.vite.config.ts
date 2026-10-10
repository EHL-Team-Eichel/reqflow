import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// Strict CSP for production builds only — the dev server needs inline scripts for React Fast Refresh.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React Flow positions nodes with inline styles
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'", // all network access happens in the main process
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "reqflow-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ],
  };
}

// Everything — workspace packages included — is bundled, so the packaged app ships no node_modules.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Keep ws's optional native probes inside try/catch so its JS fallback works.
        external: ["bufferutil", "utf-8-validate"],
        input: {
          index: resolve("src/main/index.ts"),
          "research-xlsx-worker": resolve(
            "../../packages/blocks/src/research/documents/xlsx-worker.ts",
          ),
        },
      },
    },
  },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  },
});
