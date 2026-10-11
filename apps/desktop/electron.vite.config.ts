import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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

const PDF_RUNTIME_PACKAGES = [
  "pdfjs-dist",
  "@napi-rs/canvas",
  "tesseract.js",
  "@tesseract.js-data/eng",
  "@tesseract.js-data/deu",
] as const;

function copyPdfRuntimeDependencies(): Plugin {
  let shouldWrite = true;
  return {
    name: "copy-pdf-runtime-dependencies",
    apply: "build",
    configResolved(config) {
      shouldWrite = config.build.write !== false;
    },
    closeBundle() {
      if (!shouldWrite) return;
      const targetBase = resolve(import.meta.dirname, "out/main/node_modules");
      const rootRequire = createRequire(
        resolve(import.meta.dirname, "../../packages/blocks/package.json"),
      );

      const visited = new Map<string, string>();
      const queue: Array<{ name: string; fromDir?: string; isOptional: boolean }> =
        PDF_RUNTIME_PACKAGES.map((pkg) => ({ name: pkg, isOptional: false }));

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.name)) continue;

        let pkgDir: string | null = null;
        try {
          const localReq = item.fromDir
            ? createRequire(resolve(item.fromDir, "package.json"))
            : rootRequire;
          const pkgJsonPath = localReq.resolve(`${item.name}/package.json`);
          pkgDir = dirname(pkgJsonPath);
        } catch {
          if (item.isOptional) continue;
          throw new Error(
            `Mandatory runtime dependency missing: ${item.name}${item.fromDir ? ` (required from ${item.fromDir})` : ""}`,
          );
        }

        visited.set(item.name, pkgDir);
        const pkgJson = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
        };

        for (const dep of Object.keys(pkgJson.dependencies || {})) {
          if (!visited.has(dep)) {
            queue.push({ name: dep, fromDir: pkgDir, isOptional: false });
          }
        }
        for (const dep of Object.keys(pkgJson.optionalDependencies || {})) {
          if (!visited.has(dep)) {
            queue.push({ name: dep, fromDir: pkgDir, isOptional: true });
          }
        }
      }

      mkdirSync(targetBase, { recursive: true });
      for (const [name, dir] of visited.entries()) {
        const dest = resolve(targetBase, name);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(dir, dest, { recursive: true, dereference: true, force: true });
      }
    },
  };
}

// Everything — workspace packages included — is bundled, except external runtime packages and probes.
export default defineConfig({
  main: {
    plugins: [copyPdfRuntimeDependencies()],
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Keep ws's optional native probes inside try/catch so its JS fallback works.
        external: [
          "bufferutil",
          "utf-8-validate",
          /^pdfjs-dist(\/.*)?$/,
          /^@napi-rs\/canvas(\/.*)?$/,
          /^tesseract\.js(\/.*)?$/,
          /^@tesseract\.js-data\/eng(\/.*)?$/,
          /^@tesseract\.js-data\/deu(\/.*)?$/,
        ],
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
