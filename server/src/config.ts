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

// ─── Repo keys (internal, backward-compat with gap analysis) ─────────────────

/** Internal repo key — one per git clone. Gap analysis uses "web" | "mobile". */
export type RepoKey = "web" | "mobile" | "rn_packages";

/** The two repos used by the gap-analysis pipeline (unchanged). */
export type AnalysisRepoKey = "web" | "mobile";

export const REPOS: Record<
  RepoKey,
  { name: string; url: string; dir: string }
> = {
  web: {
    name: "hyperswitch-web",
    url: "https://github.com/juspay/hyperswitch-web.git",
    dir: path.join(WORKSPACE_DIR, "web", "hyperswitch-web"),
  },
  mobile: {
    name: "hyperswitch-client-core",
    url: "https://github.com/juspay/hyperswitch-client-core.git",
    dir: path.join(WORKSPACE_DIR, "mobile", "hyperswitch-client-core"),
  },
  rn_packages: {
    name: "react-native-hyperswitch",
    url: "https://github.com/juspay/react-native-hyperswitch.git",
    dir: path.join(WORKSPACE_DIR, "mobile", "react-native-hyperswitch"),
  },
};

// ─── Integration targets (user-facing, used by integration skill) ────────────

/**
 * User-facing target for the integration skill.
 *   "mobile" = BOTH hyperswitch-client-core + react-native-hyperswitch (one coder)
 *   "web"    = hyperswitch-web
 */
export type IntegrationTarget = "web" | "mobile";

/** Namespace workspace directories — the coder's cwd for each target. */
export const MOBILE_WORKSPACE_DIR = path.join(WORKSPACE_DIR, "mobile");
export const WEB_WORKSPACE_DIR = path.join(WORKSPACE_DIR, "web");

/** Maps user-facing integration targets to internal repo keys. */
export const INTEGRATION_TARGET_REPOS: Record<IntegrationTarget, RepoKey[]> = {
  mobile: ["mobile", "rn_packages"],
  web: ["web"],
};

/** Maps user-facing integration targets to workspace directories. */
export const INTEGRATION_TARGET_CWD: Record<IntegrationTarget, string> = {
  mobile: MOBILE_WORKSPACE_DIR,
  web: WEB_WORKSPACE_DIR,
};

// ─── LLM model selection ─────────────────────────────────────────────────────

// Extraction is cheap, validation/patching is expensive.
export const MODEL_EXTRACT = "sonnet";
export const MODEL_REASON = "opus";
