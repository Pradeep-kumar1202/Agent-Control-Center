import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// project root = .../feature-gap-dashboard/
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
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
