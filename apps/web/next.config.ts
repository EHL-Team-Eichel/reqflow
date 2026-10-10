import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: [
    "@reqflow/core",
    "@reqflow/db",
    "@reqflow/engine",
    "@reqflow/llm",
    "@reqflow/nodes",
  ],
};

export default nextConfig;
