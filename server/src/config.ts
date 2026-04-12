import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// project root = .../feature-gap-dashboard/
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ── .env loader ────────────────────────────────────────────────────────────
// Loads KEY=VALUE lines from `<PROJECT_ROOT>/.env` into process.env at import
// time. Runs before any other server code reads env vars because config.ts
// is imported near the top of index.ts. No external dependency — we parse
// the file manually (dotenv is ~200 lines for what we need in ~20).
//
// Semantics:
//   - # comments and blank lines ignored
//   - KEY=value, KEY="value", KEY='value' all supported
//   - values already present in process.env are NOT overwritten, so a
//     shell-level `FOO=bar npm start` wins over the file
(function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
})();

export const WORKSPACE_DIR = path.join(PROJECT_ROOT, "workspace");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const PATCHES_DIR = path.join(DATA_DIR, "patches");
export const DB_PATH = path.join(DATA_DIR, "app.db");

export const PORT = Number(process.env.PORT ?? 5174);

export type RepoKey = "web" | "mobile";

export const REPOS: Record<
  RepoKey,
  { name: string; url: string; dir: string }
> = {
  web: {
    name: "hyperswitch-web",
    url: "https://github.com/juspay/hyperswitch-web.git",
    dir: path.join(WORKSPACE_DIR, "hyperswitch-web"),
  },
  mobile: {
    name: "hyperswitch-client-core",
    url: "https://github.com/juspay/hyperswitch-client-core.git",
    dir: path.join(WORKSPACE_DIR, "hyperswitch-client-core"),
  },
};

// LLM model selection — extraction is cheap, validation/patching is expensive.
export const MODEL_EXTRACT = "sonnet";
export const MODEL_REASON = "opus";
