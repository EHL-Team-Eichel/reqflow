import { spawn } from "node:child_process";

export interface OpenCodeExecutionOptions {
  workingDir: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export type OpenCodeRunner = (
  options: OpenCodeExecutionOptions,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Default process runner executing a command via child_process.spawn.
 */
export const defaultSystemRunner: OpenCodeRunner = async ({
  workingDir,
  args,
  timeoutMs = 300_000,
  signal,
  log,
}) => {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const child = spawn("opencode", args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`OpenCode execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const abortHandler = () => {
      child.kill("SIGTERM");
      reject(signal?.reason ?? new Error("OpenCode execution aborted"));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (log) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) log(trimmed);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (log) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) log(`[stderr] ${trimmed}`);
        }
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
};

/**
 * Pre-installs or verifies the mattpocock/skills research skill in the target working directory.
 */
export async function installResearchSkill(
  workingDir: string,
  log?: (message: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      signal?.throwIfAborted();
      log?.("Verifying and preparing research skill via npx skills...");
      const child = spawn(
        "npx",
        ["skills", "add", "https://github.com/mattpocock/skills", "--skill", "research", "-y"],
        {
          cwd: workingDir,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const timeout = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 30_000);

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          log?.("Research skill verified and ready.");
          resolve(true);
        } else {
          log?.(
            `Skill pre-install exited with code ${code}; proceeding to let agent manage skills.`,
          );
          resolve(false);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        log?.(`Skill pre-install check note: ${err.message}`);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

export interface RunOpenCodeOptions {
  workingDir: string;
  model?: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  runner?: OpenCodeRunner;
  skipSkillInstall?: boolean;
}

/**
 * Orchestrates OpenCode CLI execution in the specified directory.
 */
export async function runOpenCode(
  options: RunOpenCodeOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const {
    workingDir,
    model,
    prompt,
    timeoutMs = 300_000,
    signal,
    log,
    runner = defaultSystemRunner,
    skipSkillInstall = false,
  } = options;

  if (!skipSkillInstall) {
    await installResearchSkill(workingDir, log, signal);
  }

  const args: string[] = ["run", "--dir", workingDir];
  if (model && model.trim()) {
    args.push("-m", model.trim());
  }
  args.push("--auto", prompt);

  log?.(`Running OpenCode in ${workingDir}${model ? ` with model ${model}` : ""}...`);
  return runner({
    workingDir,
    args,
    timeoutMs,
    signal,
    log,
  });
}
