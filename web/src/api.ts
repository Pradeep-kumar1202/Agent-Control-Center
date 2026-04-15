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

export interface ChatMessageRow {
  id: number;
  patch_id: number;
  turn: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  created_at: string;
}

/**
 * One event from the POST /patches/:id/chat NDJSON stream. Mirrors
 * server/src/llm.ts → StreamChunk but with the wire field names.
 */
export interface ChatStreamChunk {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  text?: string;
  tool?: { name: string; input?: unknown; id?: string };
  toolResult?: { id: string; content?: string; isError?: boolean };
  error?: string;
  turn?: number;
}

/**
 * Final chunk emitted by POST /gaps/:id/patch/stream on success.
 * All prior chunks are plain ChatStreamChunk (text/tool_use/tool_result).
 */
export interface PatchDoneChunk {
  type: "patch_done";
  patchId: number;
  branch: string;
  repo: string;
  filesTouched: number;
  summary: string;
  diff: string;
  buildStatus: "pass";
  buildLog: string;
  prUrl: string | null;
  prNumber: number | null;
  prWarning: string | null;
}

/** Emitted at the start of each agent phase in the multi-Opus pipeline. */
export interface PhaseMarkerChunk {
  type: "phase_marker";
  phase: "analysing" | "implementing" | "verifying";
}

/**
 * Emitted when the server-side build check fails after the implementer.
 * The branch is kept alive — the chat agent can checkout and fix it.
 */
export interface PatchBuildFailedChunk {
  type: "build_failed";
  patchId: number;
  branch: string;
  repo: string;
  buildLog: string;
  diff: string;
  filesTouched: number;
}

export type PatchStreamChunk = ChatStreamChunk | PatchDoneChunk | PatchBuildFailedChunk | PhaseMarkerChunk;

export interface SkillRunSummary {
  id: number;
  skill_id: string;
  status: string;
  input_json: string;
  created_at: string;
}

export interface SkillRunRow extends SkillRunSummary {
  result_json: string;
}

export interface PatchResponse {
  patchId: number;
  branch: string;
  repo: string;
  filesTouched: number;
  summary: string;
  diff: string;
  buildStatus?: "pass" | "fail" | "skipped";
  buildLog?: string;
  prUrl?: string | null;
  prNumber?: number | null;
  prWarning?: string | null;
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
  pr_url?: string | null;
  pr_number?: number | null;
  pr_warning?: string | null;
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
  if (!r.ok) {
    // Surface the server's error body when present so the UI shows
    // "build failed: <ReScript error>" instead of an opaque HTTP code.
    let detail = "";
    try {
      const body = await r.json();
      if (body && typeof body === "object") {
        if (typeof body.error === "string") detail = body.error;
        else detail = JSON.stringify(body).slice(0, 300);
      }
    } catch { /* body wasn't JSON */ }
    throw new Error(detail ? `${r.status}: ${detail}` : `${url} → ${r.status}`);
  }
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
  streamPatch: (gapId: number, signal?: AbortSignal): Promise<Response> =>
    fetch(`${BASE}/gaps/${gapId}/patch/stream`, {
      method: "POST",
      signal,
    }),
  getPatch: (patchId: number) =>
    jsonFetch<PatchRow>(`${BASE}/patches/${patchId}`),
  getGapSource: (gapId: number) =>
    jsonFetch<{ file: string | null; content: string | null; repo: string }>(
      `${BASE}/gaps/${gapId}/source`,
    ),
  listPatches: () => jsonFetch<PatchRow[]>(`${BASE}/patches`),
  // ─── Skill run history ───────────────────────────────────────────────────
  listSkillRuns: (skillId: string) =>
    jsonFetch<SkillRunSummary[]>(`${BASE}/skills/${skillId}/runs`),
  getSkillRun: (skillId: string, runId: number) =>
    jsonFetch<SkillRunRow>(`${BASE}/skills/${skillId}/runs/${runId}`),
  deleteSkillRun: (skillId: string, runId: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/skills/${skillId}/runs/${runId}`, {
      method: "DELETE",
    }),
  // ─── Chat-with-the-patch-agent ───────────────────────────────────────────
  getChatMessages: (patchId: number) =>
    jsonFetch<{ patchId: number; messages: ChatMessageRow[] }>(
      `${BASE}/patches/${patchId}/chat`,
    ),
  clearChat: (patchId: number) =>
    jsonFetch<{ deleted: number }>(`${BASE}/patches/${patchId}/chat`, {
      method: "DELETE",
    }),
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
  listGapPrs: () => jsonFetch<GapPrRow[]>(`${BASE}/gap-prs`),
  addGapPr: (gapId: number, prUrl: string) =>
    jsonFetch<GapPrRow>(`${BASE}/gaps/${gapId}/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr_url: prUrl }),
    }),
  removeGapPr: (prId: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/gap-prs/${prId}`, {
      method: "DELETE",
    }),
  seedReset: () =>
    jsonFetch<{ message: string; gapsInserted: number; patchesRelinked: number; patchesOrphaned: number }>(
      `${BASE}/analysis/seed-reset`,
      { method: "POST" },
    ),
  listReviews: () => jsonFetch<ReviewHistoryRow[]>(`${BASE}/reviews`),
  getReview: (id: number) => jsonFetch<ReviewHistoryRow>(`${BASE}/reviews/${id}`),
  deleteReview: (id: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/reviews/${id}`, { method: "DELETE" }),
  // Preview lifecycle (demo videos)
  startPreview: (repoKey: "web" | "mobile", branch: string, kind: PreviewKind) =>
    jsonFetch<PreviewState>(`${BASE}/preview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoKey, branch, kind }),
    }),
  stopPreview: (repoKey: "web" | "mobile") =>
    jsonFetch<{ stopped: boolean; state: PreviewState | null }>(
      `${BASE}/preview/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey }),
      },
    ),
  getPreview: (repoKey: "web" | "mobile") =>
    jsonFetch<PreviewState | null>(`${BASE}/preview/${repoKey}`),
  getPreviewLogs: (repoKey: "web" | "mobile", since = 0) =>
    jsonFetch<{ lines: string[]; total: number }>(
      `${BASE}/preview/${repoKey}/logs?since=${since}`,
    ),
  // ─── Feature Agent ─────────────────────────────────────────────────────────
  createFeatureSession: (description: string) =>
    jsonFetch<FeatureSession>(`${BASE}/feature/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    }),
  listFeatureSessions: () =>
    jsonFetch<FeatureSession[]>(`${BASE}/feature/sessions`),
  getFeatureSession: (id: number) =>
    jsonFetch<FeatureSessionDetail>(`${BASE}/feature/sessions/${id}`),
  streamFeatureChat: (sessionId: number, message: string, signal?: AbortSignal): Promise<Response> =>
    fetch(`${BASE}/feature/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    }),
  triggerImplementation: (sessionId: number): Promise<Response> =>
    fetch(`${BASE}/feature/sessions/${sessionId}/implement`, { method: "POST" }),
  deleteFeatureSession: (id: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/feature/sessions/${id}`, { method: "DELETE" }),
  // ─── Documentation ─────────────────────────────────────────────────────────
  listDocs: () =>
    jsonFetch<DocSummary[]>(`${BASE}/docs`),
  getDoc: (id: number) =>
    jsonFetch<DocSummary>(`${BASE}/docs/${id}`),
  searchDocs: (q: string) =>
    jsonFetch<DocSummary[]>(`${BASE}/docs/search?q=${encodeURIComponent(q)}`),
  deleteDoc: (id: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/docs/${id}`, { method: "DELETE" }),
  regenerateDoc: (id: number) =>
    jsonFetch<DocSummary>(`${BASE}/docs/${id}/regenerate`, { method: "POST" }),
  // ─── Achievements ──────────────────────────────────────────────────────────
  getAchievementsSummary: () =>
    jsonFetch<AchievementsSummary>(`${BASE}/achievements/summary`),
  getAchievementsTimeline: () =>
    jsonFetch<TimelineEntry[]>(`${BASE}/achievements/timeline`),
  getRecentActivity: () =>
    jsonFetch<ActivityItem[]>(`${BASE}/achievements/recent`),
};

// ─── Preview manager types ───────────────────────────────────────────────────

export type PreviewKind = "web-dev" | "android-emulator";
export type PreviewStatus = "starting" | "ready" | "failed" | "stopped";

export interface PreviewState {
  repoKey: "web" | "mobile";
  kind: PreviewKind;
  branch: string;
  status: PreviewStatus;
  url?: string;
  pid?: number;
  startedAt: number;
  readyAt?: number;
  error?: string;
}

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

export interface GapPrRow {
  id: number;
  canonical_name: string;
  category: string;
  missing_in: string;
  pr_url: string;
  added_at: string;
}

export interface ReviewHistoryRow {
  id: number;
  branch: string;
  base_branch: string;
  repo: string;
  verdict: "approve" | "request_changes" | "comment" | "error";
  reviewed_at: string;
  /** Only present on GET /reviews/:id */
  result_json?: string;
}

// ─── Feature Agent types ─────────────────────────────────────────────────────

export interface FeatureSession {
  id: number;
  title: string;
  status: "discovery" | "implementing" | "done" | "failed";
  repos: string;
  branch: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeatureMessage {
  id: number;
  session_id: number;
  turn: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  created_at: string;
}

export interface FeatureSessionDetail extends FeatureSession {
  messages: FeatureMessage[];
}

// ─── Documentation types ─────────────────────────────────────────────────────

export interface DocSummary {
  id: number;
  source_type: string;
  source_id: number;
  skill_id: string | null;
  title: string;
  files_json: string;
  created_at: string;
  updated_at: string;
}

// ─── Achievements types ──────────────────────────────────────────────────────

export interface AchievementsSummary {
  totalPatches: number;
  patchesPassed: number;
  patchesFailed: number;
  buildSuccessRate: number;
  totalPRs: number;
  totalSkillRuns: number;
  skillBreakdown: Record<string, { total: number; ok: number; partial: number; error: number }>;
  totalReviews: number;
  reviewBreakdown: Record<string, number>;
  totalGapsFound: number;
  gapsVerified: number;
  gapsDismissed: number;
  gapsPatched: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
}

export interface TimelineEntry {
  date: string;
  patches: number;
  skills: number;
  reviews: number;
}

export interface ActivityItem {
  type: "patch" | "skill" | "review";
  title: string;
  description: string;
  status: string;
  timestamp: string;
  meta: { prUrl?: string | null; branch?: string; repo?: string; skillId?: string };
}

// ─── SDK Integrator skill types (SSE-based) ──────────────────────────────────

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
  skillId: "sdk-integrator";
  status: "ok" | "partial" | "error";
  results: Record<string, IntegrationRepoResult>;
  meta?: { sdkName: string; classification: SdkClassification };
}

/**
 * Start an SDK integration generation via SSE. Returns an AbortController
 * for cancellation.
 */
export function generateIntegration(
  spec: IntegrationSpec,
  onEvent: (event: IntegrationSSEEvent) => void,
  onDone: (envelope: IntegrationEnvelope) => void,
  onError: (msg: string) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`${BASE}/skills/sdk-integrator/generate`, {
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
    `${BASE}/skills/sdk-integrator/classify`,
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
