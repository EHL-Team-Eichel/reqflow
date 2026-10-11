import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createConvertedProfileIndex } from "../src/renderer/src/components/car/converter/profile.ts";

export async function writeProfileIndex(output, profile) {
  const indexFolder = join(dirname(output), "meta");
  await mkdir(indexFolder, { recursive: true });
  const index = createConvertedProfileIndex(profile, basename(output));
  await writeFile(join(indexFolder, basename(output)), JSON.stringify(index) + "\n");
}
