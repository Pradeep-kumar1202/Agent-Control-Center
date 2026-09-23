import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5174",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        /**
         * Collapse "the API server is down" into ONE actionable line.
         *
         * By default every polled request prints a full ECONNREFUSED stack, so a
         * server that failed to boot produces hundreds of lines of proxy noise
         * that scroll the actual startup error out of the terminal. That is how
         * a Node/better-sqlite3 ABI mismatch presented as a dashboard outage.
         *
         * Also answer the browser with 503 and a JSON body instead of letting
         * the socket hang up, so the UI can say "server is down" rather than
         * surfacing an opaque network error.
         */
        configure: (proxy) => {
          let reported = false;
          proxy.on("error", (err, _req, res) => {
            const down = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
            if (down && !reported) {
              reported = true;
              console.error(
                "\n[api] cannot reach the server on http://localhost:5174" +
                  "\n[api] start it with `npm run dev`, and check its output for a startup error" +
                  "\n[api] (further proxy errors suppressed until it comes back)\n",
              );
            } else if (!down) {
              console.error(`[api] proxy error: ${err.message}`);
            }
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "api_unavailable", detail: err.message }));
            }
          });
          proxy.on("proxyRes", () => { reported = false; });
        },
      },
    },
  },
});
