import vinext from "vinext";
import { defineConfig } from "vite";

// Local development intentionally uses the plain Vinext/Vite server. The
// Cloudflare Worker integration is deployment-specific and optional; keeping
// it out of this config also means local startup does not require hosting.json
// or the removed site-creator plugin.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(() => ({
    ssr: {
      external: ["@libsql/client", "@libsql/client/web"],
    },
    resolve: {
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
    server: isCodexSeatbeltSandbox
      ? { host: "127.0.0.1", watch: { useFsEvents: false, usePolling: true } }
      : { host: "127.0.0.1" },
    plugins: [vinext()],
  }));
