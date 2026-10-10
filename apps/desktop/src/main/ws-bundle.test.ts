import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { expect, it, vi } from "vitest";
import applicationConfig from "../../electron.vite.config";

interface WsHelpers {
  mask(source: Buffer, key: Buffer, output: Buffer, offset: number, length: number): void;
  unmask(buffer: Buffer, key: Buffer): void;
  isValidUTF8(buffer: Buffer): boolean;
}

it("bundles ws with working JS fallbacks when optional addons are absent in development and production", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "reqflow-ws-bundle-test-"));

  try {
    const require = createRequire(import.meta.url);
    const installedWs = dirname(require.resolve("ws/package.json"));
    const fixtureWs = join(fixture, "node_modules", "ws");
    await mkdir(join(fixtureWs, "lib"), { recursive: true });
    // Preserve ws's optional-peer metadata so Vite exercises its real resolver,
    // without resolving addons from the application's node_modules.
    for (const file of [
      "package.json",
      "lib/buffer-util.js",
      "lib/validation.js",
      "lib/constants.js",
    ]) {
      await copyFile(join(installedWs, file), join(fixtureWs, file));
    }
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({ name: "reqflow-ws-bundle-fixture", type: "module" }),
    );
    const entry = join(fixture, "entry.mjs");
    await writeFile(
      entry,
      `import helpers from './node_modules/ws/lib/buffer-util.js';
import validation from './node_modules/ws/lib/validation.js';
export const { mask, unmask } = helpers;
export const { isValidUTF8 } = validation;
`,
    );

    const main = applicationConfig.main;
    if (!main) throw new Error("The application must configure its main-process build");

    for (const mode of ["development", "production"]) {
      // Vite's optional-peer transform uses NODE_ENV, not just the mode option.
      vi.stubEnv("NODE_ENV", mode);
      const result = await build({
        ...main,
        root: fixture,
        configFile: false,
        envFile: false,
        publicDir: false,
        mode,
        logLevel: "silent",
        // Match electron-vite's Node bundling preset; reuse the application's
        // Rollup externals rather than duplicating the optional-addon fix here.
        ssr: { ...main.ssr, noExternal: true },
        build: {
          ...main.build,
          ssr: true,
          target: "node22",
          minify: false,
          write: false,
          outDir: join(fixture, "out"),
          rollupOptions: {
            ...main.build?.rollupOptions,
            input: entry,
            output: { format: "cjs", entryFileNames: "ws-helpers.cjs" },
          },
        },
      });
      if (!("output" in result)) throw new Error(`${mode}: expected a single Vite build`);
      const chunk = result.output.find((output) => output.type === "chunk" && output.isEntry);
      if (!chunk || chunk.type !== "chunk") {
        throw new Error(`${mode}: Vite did not emit the ws helpers`);
      }

      const addonProbes: string[] = [];
      const emittedModule = { exports: {} as WsHelpers };
      runInNewContext(
        chunk.code,
        {
          Buffer,
          module: emittedModule,
          exports: emittedModule.exports,
          // Neither opt-out flag is set, and no real environment enters the bundle.
          process: { env: {} },
          require(id: string) {
            // Hide buffer.isUtf8 only in this sandbox so modern Node also
            // exercises ws's utf-8-validate probe and JavaScript fallback.
            if (id === "buffer" || id === "node:buffer") return {};
            addonProbes.push(id);
            throw Object.assign(new Error(`Cannot find module '${id}'`), {
              code: "MODULE_NOT_FOUND",
            });
          },
        },
        { filename: join(fixture, chunk.fileName), timeout: 1_000 },
      );
      // Successful initialization after both requires throw proves the emitted
      // probes remain guarded, instead of becoming eager errors or empty stubs.
      expect(addonProbes, `${mode}: guarded optional-addon requires`).toEqual([
        "bufferutil",
        "utf-8-validate",
      ]);

      const helpers = emittedModule.exports;
      const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
      // Both lengths exceed ws's native mask/unmask thresholds; the odd length
      // also checks the tail of a frame instead of only complete mask groups.
      for (const length of [64, 65]) {
        const source = Buffer.from(Array.from({ length }, (_, i) => (i * 17 + 23) % 256));
        const offset = 3;
        const output = Buffer.alloc(length + offset + 3, 0xaa);
        const expected = Buffer.from(output);
        expected.set(
          source.map((byte, i) => byte ^ key[i & 3]!),
          offset,
        );

        helpers.mask(source, key, output, offset, length);
        expect(output, `${mode}: masks a ${length}-byte frame at an offset`).toEqual(expected);

        const masked = output.subarray(offset, offset + length);
        helpers.unmask(masked, key);
        expect(masked, `${mode}: restores a ${length}-byte frame`).toEqual(source);
      }
      expect(
        helpers.isValidUTF8(Buffer.from("é😀".repeat(16))),
        `${mode}: validates long UTF-8 without the native addon`,
      ).toBe(true);
      expect(
        helpers.isValidUTF8(Buffer.alloc(64, 0xff)),
        `${mode}: rejects invalid UTF-8 without the native addon`,
      ).toBe(false);
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);
