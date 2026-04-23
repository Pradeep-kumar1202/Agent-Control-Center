// Thin API client. The vite dev server proxies /api → http://localhost:5174.
const BASE = "/api";

/**
 * Thrown when an action targets a patch whose git branch no longer exists
 * locally AND isn't on origin. Raised from jsonFetch when the server replies
 * 409 with `code: "BRANCH_GONE"`. Components catch it by `instanceof` to
 * mark the patch row stale and prompt the user to regenerate — without
 * showing the raw git pathspec error.
 */
export class BranchGoneError extends Error {
  readonly code = "BRANCH_GONE" as const;
  constructor(
    message: string,
    readonly branch: string,
    readonly repo: "web" | "mobile",
  ) {
    super(message);
    this.name = "BranchGoneError";
  }
}

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
 *
 * `code`, `branch`, `repo` are populated on structured errors (currently
 * only BRANCH_GONE — the chat route streams these when a pre-flight says
 * the branch is reachable but it disappears by the time the lock is held).
 */
export interface ChatStreamChunk {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  text?: string;
  tool?: { name: string; input?: unknown; id?: string };
  toolResult?: { id: string; content?: string; isError?: boolean };
  error?: string;
  code?: "BRANCH_GONE";
  branch?: string;
  repo?: "web" | "mobile";
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

export type PrState =
  | "draft"
  | "awaiting_review"
  | "changes_requested"
  | "approved"
  | "merged"
  | "tested";

export const PR_STATES: readonly PrState[] = [
  "draft",
  "awaiting_review",
  "changes_requested",
  "approved",
  "merged",
  "tested",
];

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

/**
 * Result of GET /patches/branch-health, keyed by patch id.
 * - `exists`      — the branch is present in the local clone right now.
 * - `recoverable` — if missing locally, whether it can still be fetched from
 *   origin. A row is considered "stale" only when both are false, i.e. the
 *   branch is gone from every reachable location.
 */
export interface PatchBranchHealth {
  exists: boolean;
  recoverable: boolean;
}

export type PatchBranchHealthMap = Record<number, PatchBranchHealth>;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    // Surface the server's error body when present so the UI shows
    // "build failed: <ReScript error>" instead of an opaque HTTP code.
    let detail = "";
    let body: unknown = null;
    try {
      body = await r.json();
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (typeof b.error === "string") detail = b.error;
        else detail = JSON.stringify(b).slice(0, 300);
      }
    } catch { /* body wasn't JSON */ }
    // Typed recovery path: the server signals "this patch's branch is gone"
    // via 409 + {code: "BRANCH_GONE"}. Callers catch BranchGoneError to
    // self-heal (drop the row from patchedGaps, prompt regenerate).
    if (r.status === 409 && body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (b.code === "BRANCH_GONE" && typeof b.branch === "string" && typeof b.repo === "string") {
        throw new BranchGoneError(
          typeof b.message === "string" ? b.message : detail,
          b.branch,
          b.repo as "web" | "mobile",
        );
      }
    }
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
  /**
   * Branch-health is advisory — the per-action 409 path is the real
   * source of truth. Cap the request at 8 s so a slow/unreachable
   * origin (ls-remote hang) can never stall the dashboard refresh loop.
   * On timeout or any network error the caller falls back to "assume fresh".
   */
  patchBranchHealth: () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    return jsonFetch<PatchBranchHealthMap>(`${BASE}/patches/branch-health`, {
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  },
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
  listPrStates: () => jsonFetch<PrStateMap>(`${BASE}/pr-states`),
  setPrState: (prUrl: string, state: PrState | null) =>
    jsonFetch<{ pr_url: string; state: PrState | null; updated_at: string | null }>(
      `${BASE}/pr-state`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pr_url: prUrl, state }),
      },
    ),
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
  // Mock merchant server (in-process, port 5252)
  getMockServer: () => jsonFetch<MockServerState>(`${BASE}/preview/mock-server`),
  startMockServer: () =>
    jsonFetch<MockServerState>(`${BASE}/preview/mock-server/start`, { method: "POST" }),
  stopMockServer: () =>
    jsonFetch<MockServerState>(`${BASE}/preview/mock-server/stop`, { method: "POST" }),
  setMockServerConfig: (paymentIntentBody: Record<string, unknown>) =>
    jsonFetch<MockServerState>(`${BASE}/preview/mock-server/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentIntentBody }),
    }),
  tailMockServerLogs: (since = 0) =>
    jsonFetch<{ lines: string[]; total: number }>(
      `${BASE}/preview/mock-server/logs?since=${since}`,
    ),
  getMockServerCredentials: () =>
    jsonFetch<HyperswitchCredentials>(`${BASE}/preview/mock-server/credentials`),
  setMockServerCredentials: (patch: Partial<HyperswitchCredentials>) =>
    jsonFetch<HyperswitchCredentials>(`${BASE}/preview/mock-server/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  // ─── Test-suite runs (Detox / Cypress) ─────────────────────────────────────
  listTestRuns: (params: { repo?: "web" | "mobile"; branch?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.repo) q.set("repo", params.repo);
    if (params.branch) q.set("branch", params.branch);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return jsonFetch<TestRunSummary[]>(`${BASE}/skills/tests/runs${qs ? `?${qs}` : ""}`);
  },
  getTestRun: (id: number) =>
    jsonFetch<TestRunFull>(`${BASE}/skills/tests/runs/${id}`),
  resolvePrUrl: (prUrl: string) =>
    jsonFetch<{ branch: string; prUrl: string }>(`${BASE}/skills/tests/resolve-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl }),
    }),
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
    jsonFetch<DocFull>(`${BASE}/docs/${id}`),
  searchDocs: (q: string) =>
    jsonFetch<DocSummary[]>(`${BASE}/docs/search?q=${encodeURIComponent(q)}`),
  deleteDoc: (id: number) =>
    jsonFetch<{ deleted: boolean }>(`${BASE}/docs/${id}`, { method: "DELETE" }),
  regenerateDoc: (id: number) =>
    jsonFetch<DocFull>(`${BASE}/docs/${id}/regenerate`, { method: "POST" }),
  regenerateOfficialDoc: (id: number) =>
    jsonFetch<DocFull>(`${BASE}/docs/${id}/regenerate-official`, { method: "POST" }),
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

export interface MockServerState {
  running: boolean;
  port: number;
  startedAt: number | null;
  paymentIntentBody: Record<string, unknown>;
}

/**
 * Hyperswitch credentials used by the mock merchant server AND by Cypress.
 * Editable at runtime from the Preview → Credentials panel; the server
 * falls back to .env values when a field is empty.
 */
export interface HyperswitchCredentials {
  publishableKey: string;
  secretKey: string;
  profileId: string;
  netceteraApiKey: string;
  baseUrl: string;
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

export type TestRunStatus = "running" | "passed" | "failed" | "error";

export interface TestRunSummary {
  id: number;
  repo: "web" | "mobile";
  branch: string;
  pr_url: string | null;
  status: TestRunStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  pass_count: number | null;
  fail_count: number | null;
  error_message: string | null;
}

export interface TestRunFull extends TestRunSummary {
  logs_ndjson: string | null;
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

export interface PrStateEntry {
  state: PrState;
  updated_at: string;
}

export type PrStateMap = Record<string, PrStateEntry>;

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

/** Full doc row returned by GET /docs/:id. Carries both markdown bodies. */
export interface DocFull extends DocSummary {
  content: string;
  official_content: string | null;
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
