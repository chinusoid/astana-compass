import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  poweredByHeader: false,
  // OpenNext resolves this independent pnpm project as its package root.
  // Shared contracts are compiled into the app; no runtime files live outside it.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  turbopack: { root: path.resolve(import.meta.dirname) },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self)" },
        ],
      },
    ];
  },
};
export default config;
