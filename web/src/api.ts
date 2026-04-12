// Thin API client. The vite dev server proxies /api → http://localhost:5174.
const BASE = "/api";

export interface Report {
  id: number;
  created_at: string;
  web_sha: string;
  mobile_sha: string;
  status: "running" | "done" | "failed";
  error: string | null;
}

export interface Evidence {
  name: string;
  file: string;
  snippet: string;
}

export interface Gap {
  id: number;
  report_id: number;
  category: "payment_method" | "config" | "component" | "backend_api";
  canonical_name: string;
  missing_in: "web" | "mobile";
  present_in: "web" | "mobile";
  evidence: Evidence[];
  rationale: string;
  severity: "low" | "medium" | "high";
  platform_specific: 0 | 1;
  verified: 0 | 1;
}

export type ValidateResponse =
  | {
      verdict: "false_positive";
      removed: true;
      found_in_missing?: string;
      rationale: string;
    }
  | {
      verdict: "confirmed" | "platform_specific";
      removed: false;
      gap: Gap;
    };

export interface PatchResponse {
  patchId: number;
  branch: string;
  repo: string;
  filesTouched: number;
  summary: string;
  diff: string;
  buildStatus?: "pass" | "fail" | "skipped";
  buildLog?: string;
}

export interface PatchRow {
  id: number;
  gap_id: number;
  repo: string;
  branch: string;
  diff_path: string;
  summary: string;
  files_touched: number;
  status: string;
  created_at: string;
  diff?: string;
  build_status?: "pass" | "fail" | "skipped" | null;
  build_log?: string | null;
  // Enriched from JOIN with gaps table
  canonical_name?: string;
  category?: string;
  missing_in?: string;
}

export interface Health {
  ok: boolean;
  counts: { reports: number; gaps: number; patches: number };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

function skillPost<T>(skillId: string, spec: unknown): Promise<T> {
  return jsonFetch<T>(`${BASE}/skills/${skillId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export const api = {
  health: () => jsonFetch<Health>(`${BASE}/health`),
  latestReport: () => jsonFetch<Report | null>(`${BASE}/reports/latest`),
  gaps: (reportId?: number) =>
    jsonFetch<Gap[]>(
      `${BASE}/gaps${reportId ? `?report_id=${reportId}` : ""}`,
    ),
  runAnalysis: () =>
    jsonFetch<{ accepted: boolean }>(`${BASE}/analyze`, { method: "POST" }),
  cancelAnalysis: () =>
    jsonFetch<{ cancelled: boolean; killed: number }>(
      `${BASE}/analyze/cancel`,
      { method: "POST" },
    ),
  validateGap: (id: number) =>
    jsonFetch<ValidateResponse>(`${BASE}/gaps/${id}/validate`, {
      method: "POST",
    }),
  generatePatch: (gapId: number) =>
    jsonFetch<PatchResponse>(`${BASE}/gaps/${gapId}/patch`, {
      method: "POST",
    }),
  getPatch: (patchId: number) =>
    jsonFetch<PatchRow>(`${BASE}/patches/${patchId}`),
  getGapSource: (gapId: number) =>
    jsonFetch<{ file: string | null; content: string | null; repo: string }>(
      `${BASE}/gaps/${gapId}/source`,
    ),
  listPatches: () => jsonFetch<PatchRow[]>(`${BASE}/patches`),
  // Legacy props endpoint (backward compat)
  generateProp: (spec: PropSpec) =>
    jsonFetch<PropGenerateResponse>(`${BASE}/props/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    }),
  // Skills API (unified envelope)
  generatePropsSkill: (spec: PropSpec) =>
    skillPost<SkillEnvelope>("props", spec),
  generateTests: (spec: TestWriterSpec) =>
    skillPost<SkillEnvelope>("tests", spec),
  generateTranslations: (spec: TranslationSpec) =>
    skillPost<SkillEnvelope>("translations", spec),
  generateReview: (spec: ReviewSpec) =>
    skillPost<SkillEnvelope>("review", spec),
};

export interface PropSpec {
  propName: string;
  type: string;
  default: string;
  parentConfig?: string;
  behavior: string;
  platforms: string[];
}

export interface PropRepoResult {
  repo: string;
  branch: string;
  summary: string;
  diff: string;
  filesTouched: number;
  error?: string;
}

export interface PropGenerateResponse {
  propName: string;
  results: Record<string, PropRepoResult>;
}

// ─── Unified skill envelope (all new skills) ─────────────────────────────────

export interface SkillEnvelope {
  skillId: string;
  status: "ok" | "partial" | "error";
  results: Record<string, SkillRepoResult>;
  meta?: Record<string, unknown>;
}

export interface SkillRepoResult {
  repo: string;
  branch: string;
  diff: string;
  filesTouched: number;
  summary: string;
  error?: string;
}

export interface TestWriterSpec {
  branch: string;
  repo: "web" | "mobile" | "both";
  featureDescription: string;
  baseBranch?: string;
}

export interface TranslationSpec {
  keyName: string;
  englishValue: string;
  context: string;
}

export interface ReviewSpec {
  branch: string;
  baseBranch?: string;
  repo: "web" | "mobile" | "both";
}

// ─── Integration skill (SSE-based) ──────────────────────────────────────────

/** A single step in the API call chain that bootstraps the SDK. */
export interface ApiChainStep {
  endpoint: string;
  triggerField?: string;
  triggerValue?: string;
  extractedData?: string[];
}

export type UiEntryPoint =
  | "branded_button"
  | "inline_widget"
  | "invisible"
  | "utility_ui"
  | "other";

export type ApiChainKnownPattern =
  | "session_direct"
  | "session_post_session"
  | "confirm_next_action"
  | "no_api"
  | "custom";

export type ConfirmTiming =
  | "post_sdk_with_data"
  | "post_sdk_status_only"
  | "pre_sdk"
  | "not_applicable"
  | "custom";

export interface SdkClassification {
  // Technical detection (auto-detected from SDK doc)
  pattern: string;
  callbackMechanism: string;
  requiresActivity: boolean;
  requiresUrlScheme: boolean;
  hasNativeUI: boolean;
  notes: string;

  // UI entry point
  uiEntryPoint: UiEntryPoint;
  sdkProvidesButton?: boolean;

  // API chain
  apiChain: {
    knownPattern?: ApiChainKnownPattern;
    steps: ApiChainStep[];
    description?: string;
  };

  // Confirm timing
  confirmTiming: ConfirmTiming;

  // Hyperswitch-specific (user fills in)
  walletVariant?: string;
  sdkNextAction?: string;
  nextActionType?: string;
  paymentExperience?: string;

  // Reference pattern (auto-derived)
  referencePattern?: string;
  targetFiles: string[];
}

export interface IntegrationSpec {
  sdkName: string;
  sdkDoc: string;
  classification: SdkClassification;
  targets: Array<"web" | "mobile">;
  platforms: string[];
  newPackage?: boolean;
  newPackageName?: string;
  additionalContext?: string;
  /** Which sub-repos to include when target is "mobile". Defaults to both. */
  mobileSubRepos?: Array<"client_core" | "rn_packages">;
}

export interface IntegrationSSEEvent {
  type:
    | "progress"
    | "review_start"
    | "review_result"
    | "fix_start"
    | "repo_done"
    | "done"
    | "error";
  repo?: string;
  message: string;
  data?: unknown;
}

export interface ReviewIssue {
  file: string;
  check: string;
  severity: "blocker" | "warning" | "nit";
  description: string;
  suggestedFix: string;
}

export interface ReviewResult {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface IntegrationRepoResult extends SkillRepoResult {
  reviewLog: Array<{ iteration: number; review: ReviewResult }>;
}

export interface IntegrationEnvelope {
  skillId: "integration";
  status: "ok" | "partial" | "error";
  results: Record<string, IntegrationRepoResult>;
  meta?: { sdkName: string; classification: SdkClassification };
}

/**
 * Start an integration generation via SSE. Returns an EventSource-like
 * interface that the Form component can subscribe to.
 */
export function generateIntegration(
  spec: IntegrationSpec,
  onEvent: (event: IntegrationSSEEvent) => void,
  onDone: (envelope: IntegrationEnvelope) => void,
  onError: (msg: string) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`${BASE}/skills/integration/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onError(`HTTP ${response.status}: ${text}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as IntegrationSSEEvent;
              onEvent(event);

              if (event.type === "done" && event.data) {
                onDone(event.data as IntegrationEnvelope);
              }
            } catch {
              /* ignore malformed SSE data */
            }
          }
        }
      }
    })
    .catch((err) => {
      if ((err as Error).name !== "AbortError") {
        onError((err as Error).message);
      }
    });

  return controller;
}

/**
 * Classify an SDK from its documentation. Returns the SdkClassification
 * with auto-derived referencePattern and targetFiles.
 */
export async function classifySdk(
  sdkDoc: string,
  sdkTypeHint?: string,
): Promise<SdkClassification> {
  return jsonFetch<SdkClassification>(
    `${BASE}/skills/integration/classify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdkDoc, sdkTypeHint }),
    },
  );
}

// ─── Coder skill (SSE-based) ────────────────────────────────────────────────

export interface CoderSpec {
  repos: Array<"web" | "mobile" | "rn_packages">;
  task: string;
  additionalContext?: string;
}

export type CoderSSEEvent = IntegrationSSEEvent; // Same shape

export interface CoderRepoResult extends SkillRepoResult {
  reviewLog: Array<{ iteration: number; review: ReviewResult }>;
}

export interface CoderEnvelope {
  skillId: "coder";
  status: "ok" | "partial" | "error";
  results: Record<string, CoderRepoResult>;
  meta?: { task: string };
}

/**
 * Start a coder task via SSE. Returns an AbortController for cancellation.
 */
export function generateCoderTask(
  spec: CoderSpec,
  onEvent: (event: CoderSSEEvent) => void,
  onDone: (envelope: CoderEnvelope) => void,
  onError: (msg: string) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`${BASE}/skills/coder/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onError(`HTTP ${response.status}: ${text}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as CoderSSEEvent;
              onEvent(event);

              if (event.type === "done" && event.data) {
                onDone(event.data as CoderEnvelope);
              }
            } catch {
              /* ignore malformed SSE data */
            }
          }
        }
      }
    })
    .catch((err) => {
      if ((err as Error).name !== "AbortError") {
        onError((err as Error).message);
      }
    });

  return controller;
}
