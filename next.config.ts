import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Embedded Postgres ships WASM files and pg uses Node APIs: load both with Node's own require.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  turbopack: {
    // A package-lock.json further up (on the Desktop) would otherwise be taken as the workspace root.
    root: fileURLToPath(new URL(".", import.meta.url)),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
