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
