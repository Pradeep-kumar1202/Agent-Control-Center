/**
 * Deterministic patch validators — zero tokens, pure logic.
 *
 * The existing gates ask "does it compile" and "does the model think it matches
 * the spec". Neither can see that a diff quietly staged a lockfile, hand-edited
 * generated output, left `Js.log` behind, or reached for `Obj.magic` to silence
 * the typechecker — which is precisely how "the build is green" coexists with
 * "the code is wrong".
 *
 * Same shape and philosophy as `validators.ts`: run after the LLM, before the
 * user sees anything, and never ask a model what code can answer.
 *
 * Deliberately conservative. A validator that wrongly rejects silently discards
 * real work, which is worse than letting a warning through — so anything whose
 * truth depends on repo architecture (which target file plays which role) is a
 * WARNING, and only unambiguous facts REJECT.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

export type PatchRuleId =
  | "diff/empty" | "diff/malformed" | "diff/path_mismatch"
  | "scope/lockfile" | "scope/generated" | "scope/gitignored"
  | "scope/binary" | "scope/env" | "scope/gitmodules" | "scope/docs_only" | "scope/tests_only"
  | "size/too_many_files" | "size/too_many_lines" | "size/single_file_rewrite" | "size/single_file"
  | "spec/config_key_absent" | "spec/type_absent" | "spec/layer_missing"
  | "residue/debug_log" | "residue/conflict_marker" | "residue/type_escape"
  | "residue/warning_suppression" | "residue/todo";

/**
 * Structurally a superset of `ReviewIssue` (severity/category/file/line/message/
 * suggestion), so findings flow straight through `deduplicateIssues`,
 * `computeVerdict` and `buildReviewSummary` in validators.ts with no adapter.
 */
export interface PatchFinding {
  rule: PatchRuleId;
  level: "reject" | "warn";
  severity: "blocking" | "suggestion" | "nitpick";
  category: "correctness" | "patterns" | "tests" | "translations" | "security" | "types" | "edge_cases";
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  detail?: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  isBinary: boolean;
  /** Added lines with the leading '+' stripped. Residue rules only look here. */
  addedLines: string[];
}

export interface SpecLike {
  configKey?: string;
  typeDefinition?: string;
  allRelatedFiles?: Array<{ path: string; role: string }>;
}

export interface PatchQualityReport {
  findings: PatchFinding[];
  rejected: boolean;
  stats: { files: number; added: number; removed: number };
  ranAt: string;
}

// ─── diff parsing ────────────────────────────────────────────────────────────

/**
 * Parse a unified diff into per-file records.
 *
 * Paths come from the `diff --git` header rather than `+++`, because the two
 * can disagree (they did, for submodule diffs, until submoduleGit.ts was fixed
 * to let git emit the prefixes). `checkPathHeaders` reports that disagreement
 * explicitly instead of silently preferring one side.
 */
export function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let sawNewFile = false;
  let sawDeleted = false;
  let sawRename = false;

  const flush = () => {
    if (!cur) return;
    cur.status = sawNewFile ? "added" : sawDeleted ? "deleted" : sawRename ? "renamed" : "modified";
    files.push(cur);
    cur = null;
    sawNewFile = sawDeleted = sawRename = false;
  };

  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      flush();
      cur = {
        path: header[2],
        status: "modified",
        added: 0, removed: 0,
        isBinary: false,
        addedLines: [],
      };
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("new file mode")) { sawNewFile = true; continue; }
    if (line.startsWith("deleted file mode")) { sawDeleted = true; continue; }
    if (line.startsWith("rename from") || line.startsWith("rename to")) { sawRename = true; continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      cur.isBinary = true;
      continue;
    }
    // Skip metadata that would otherwise be miscounted as content.
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") ||
        line.startsWith("@@") || line.startsWith("similarity index") ||
        line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) { cur.added++; cur.addedLines.push(line.slice(1)); continue; }
    if (line.startsWith("-")) { cur.removed++; continue; }
  }
  flush();
  return files;
}

function finding(
  rule: PatchRuleId,
  level: "reject" | "warn",
  message: string,
  extra: Partial<PatchFinding> = {},
): PatchFinding {
  return {
    rule,
    level,
    severity: level === "reject" ? "blocking" : "suggestion",
    category: extra.category ?? "correctness",
    message,
    ...extra,
  };
}

// ─── scope ───────────────────────────────────────────────────────────────────

/**
 * Which paths a patch may touch, per gap category.
 *
 * Category-specific because a blanket rule is wrong in both directions: a
 * dependency-bearing feature legitimately updates a lockfile, while a `config`
 * gap that touches one has certainly gone off the rails.
 */
export interface ScopePolicy {
  allowLockfiles: boolean;
  allowGitmodules: boolean;
  allowNative: boolean;   // ios/ and android/ trees
}

export function scopePolicyFor(category: string): ScopePolicy {
  switch (category) {
    case "config":
      return { allowLockfiles: false, allowGitmodules: false, allowNative: false };
    case "component":
      return { allowLockfiles: false, allowGitmodules: false, allowNative: true };
    default:
      return { allowLockfiles: true, allowGitmodules: false, allowNative: true };
  }
}

const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Gemfile\.lock)$/;
const BUILD_ARTIFACTS = /(^|\/)(node_modules|lib\/bs|lib\/js|\.gradle|build|dist|DerivedData)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|jar|aar|apk|so|dylib|a|keystore|ttf|otf|woff2?)$/i;

/**
 * ReScript compiler output, which must never be hand-edited.
 *
 * `checkGeneratedFiles` already catches this via `git check-ignore`, and that
 * is the primary defence because it tracks each repo's real .gitignore. This
 * is a backstop: both SDKs currently build with `suffix: ".bs.js"` and ignore
 * it, but ReScript 11+ defaults to `.res.js`, which NEITHER repo's .gitignore
 * covers today. Verified both repos track zero files of either suffix, so
 * rejecting both is safe now and stays correct through a suffix bump.
 */
const RESCRIPT_OUTPUT = /\.(bs|res)\.js$/;

export function checkDiffScope(files: DiffFile[], policy: ScopePolicy): PatchFinding[] {
  const out: PatchFinding[] = [];
  for (const f of files) {
    if (!policy.allowLockfiles && LOCKFILES.test(f.path)) {
      out.push(finding("scope/lockfile", "reject",
        `Dependency lockfile modified: ${f.path}`, {
          file: f.path, category: "patterns",
          suggestion: "This gap category should not change dependencies. Revert the lockfile.",
        }));
    }
    if (BUILD_ARTIFACTS.test(f.path)) {
      out.push(finding("scope/generated", "reject",
        `Build artifact committed: ${f.path}`, { file: f.path, category: "patterns" }));
    }
    if (RESCRIPT_OUTPUT.test(f.path)) {
      out.push(finding("scope/generated", "reject",
        `ReScript compiler output was edited: ${f.path}`, {
          file: f.path, category: "patterns",
          suggestion: "Edit the .res source; the .js is regenerated by the build.",
        }));
    }
    if (f.isBinary || BINARY_EXT.test(f.path)) {
      out.push(finding("scope/binary", "reject",
        `Binary file in patch: ${f.path}`, { file: f.path, category: "patterns" }));
    }
    if (/(^|\/)\.env($|\.)/.test(f.path)) {
      out.push(finding("scope/env", "reject",
        `Environment file modified: ${f.path}`, {
          file: f.path, category: "security",
          suggestion: "Credentials and env files must never appear in a generated patch.",
        }));
    }
    if (!policy.allowGitmodules && /(^|\/)\.gitmodules$/.test(f.path)) {
      // The submodule-fork rewrite is a SEPARATE commit made after the diff is
      // captured. Seeing it inside the diff means the ordering broke.
      out.push(finding("scope/gitmodules", "reject",
        ".gitmodules changed inside the feature diff", {
          file: f.path, category: "patterns",
          suggestion: "The fork rewrite must be its own commit after diff capture.",
        }));
    }
    if (!policy.allowNative && /^(ios|android)\//.test(f.path)) {
      out.push(finding("scope/generated", "warn",
        `Native platform file changed for a ${"config"} gap: ${f.path}`, {
          file: f.path, category: "patterns",
        }));
    }
  }

  const real = files.filter((f) => f.status !== "deleted");
  if (real.length > 0) {
    if (real.every((f) => /\.(md|mdx|txt)$/i.test(f.path))) {
      out.push(finding("scope/docs_only", "reject",
        "Patch only changes documentation — no implementation", { category: "correctness" }));
    } else if (real.every((f) => /(^|\/)(cypress-tests|detox-tests|__tests__|e2e)\//.test(f.path))) {
      out.push(finding("scope/tests_only", "reject",
        "Patch only adds tests — the feature itself was not implemented", { category: "tests" }));
    }
  }
  return out;
}

/**
 * Reject anything the repo's own .gitignore excludes.
 *
 * Generic on purpose: it stays correct as each SDK's .gitignore evolves, where
 * a hardcoded extension denylist would drift. ReScript emits `.res.js`/`.bs.js`
 * that must never be hand-edited, and both repos already ignore them.
 */
export function checkGeneratedFiles(repoDir: string, files: DiffFile[]): PatchFinding[] {
  const paths = files.map((f) => f.path);
  if (paths.length === 0) return [];
  let ignored: string[] = [];
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: repoDir, input: paths.join("\n"), encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    ignored = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    // exit 1 simply means "nothing ignored"; anything else is a real failure.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return [];
    ignored = String(e.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  }
  return ignored.map((p) =>
    finding("scope/gitignored", "reject",
      `Git-ignored (generated) file was edited: ${p}`, {
        file: p, category: "patterns",
        suggestion: "Edit the ReScript source, not its compiled output.",
      }));
}

// ─── size ────────────────────────────────────────────────────────────────────

export interface SizeLimits {
  maxFiles: number;
  maxAdded: number;
  maxAddedPerFile: number;
}

/** LEARNINGS: a real cross-layer gap spans roughly 4-6 files. */
export const DEFAULT_SIZE_LIMITS: SizeLimits = {
  maxFiles: 25,
  maxAdded: 1200,
  maxAddedPerFile: 600,
};

export function checkDiffSize(files: DiffFile[], limits = DEFAULT_SIZE_LIMITS): PatchFinding[] {
  const out: PatchFinding[] = [];
  const totalAdded = files.reduce((n, f) => n + f.added, 0);

  if (files.length > limits.maxFiles) {
    out.push(finding("size/too_many_files", "reject",
      `${files.length} files changed (limit ${limits.maxFiles}) — probable scope creep`,
      { category: "patterns" }));
  }
  if (totalAdded > limits.maxAdded) {
    out.push(finding("size/too_many_lines", "reject",
      `${totalAdded} lines added (limit ${limits.maxAdded}) — probable scope creep`,
      { category: "patterns" }));
  }
  for (const f of files) {
    if (f.added > limits.maxAddedPerFile) {
      // A file that is mostly rewritten can compile perfectly and still be a
      // semantic disaster; the build gate cannot see the difference.
      out.push(finding("size/single_file_rewrite", "reject",
        `${f.path}: ${f.added} lines added — the file was rewritten rather than edited`,
        { file: f.path, category: "patterns" }));
    }
  }
  if (files.length === 1 && files[0].status === "modified") {
    out.push(finding("size/single_file", "warn",
      `Only one file changed (${files[0].path}) — a cross-layer SDK feature normally spans type, parser and render`,
      { file: files[0].path, category: "correctness" }));
  }
  return out;
}

// ─── residue ─────────────────────────────────────────────────────────────────

const RESIDUE_REJECT: Array<{ rule: PatchRuleId; re: RegExp; msg: string; category?: PatchFinding["category"] }> = [
  { rule: "residue/debug_log", re: /\b(Js\.log|Console\.log|console\.log|print_endline|debugger)\b/, msg: "Debug logging left in" },
  { rule: "residue/conflict_marker", re: /^(<{7}|={7}|>{7})/, msg: "Merge conflict marker left" },
  // The type-hole a model reaches for when it cannot satisfy the checker. This
  // is exactly how a green build hides broken code.
  { rule: "residue/type_escape", re: /\b(Obj\.magic)\b|%%?raw\b/, msg: "Type escape hatch (Obj.magic / %raw) used", category: "types" },
  { rule: "residue/warning_suppression", re: /@@?warning\(\s*"-/, msg: "Compiler warning suppressed instead of fixed", category: "types" },
];

const RESIDUE_WARN: Array<{ rule: PatchRuleId; re: RegExp; msg: string }> = [
  { rule: "residue/todo", re: /\b(TODO|FIXME|XXX|HACK)\b/, msg: "TODO/FIXME left in" },
];

/** Added lines only — pre-existing residue is not this patch's fault. */
export function checkDebugResidue(files: DiffFile[]): PatchFinding[] {
  const out: PatchFinding[] = [];
  for (const f of files) {
    for (const [i, line] of f.addedLines.entries()) {
      for (const r of RESIDUE_REJECT) {
        if (r.re.test(line)) {
          out.push(finding(r.rule, "reject", `${r.msg} — ${f.path}`, {
            file: f.path, line: i + 1, category: r.category ?? "correctness",
            detail: line.trim().slice(0, 160),
          }));
        }
      }
      for (const r of RESIDUE_WARN) {
        if (r.re.test(line)) {
          out.push(finding(r.rule, "warn", `${r.msg} in ${f.path}`, {
            file: f.path, line: i + 1, detail: line.trim().slice(0, 160),
          }));
        }
      }
    }
  }
  return out;
}

// ─── spec coverage ───────────────────────────────────────────────────────────

/**
 * Check the diff actually wires up what the spec described.
 *
 * Only the config-key check can reject, and only for config-category gaps:
 * a patch that never mentions the integrator-facing key did not implement the
 * feature, no matter how green the build is — and that is exactly the class the
 * fail-open verifier waves through. Everything else warns, because
 * `spec.allRelatedFiles` lists SOURCE paths and the target repo's corresponding
 * files cannot be derived from them mechanically (different architectures is
 * the entire premise of this project).
 */
export function checkSpecCoverage(
  files: DiffFile[],
  spec: SpecLike | null,
  category: string,
): PatchFinding[] {
  if (!spec) return [];
  const out: PatchFinding[] = [];
  const added = files.flatMap((f) => f.addedLines).join("\n");

  const key = spec.configKey?.trim();
  if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    const present = new RegExp(`\\b${key}\\b`).test(added) ||
                    new RegExp(`\\b${toSnake(key)}\\b`).test(added) ||
                    new RegExp(`\\b${toCamel(key)}\\b`).test(added);
    if (!present) {
      out.push(finding("spec/config_key_absent",
        category === "config" ? "reject" : "warn",
        `Config key "${key}" appears nowhere in the added lines`, {
          category: "correctness",
          suggestion: "The integrator-facing key must be read somewhere for the feature to exist.",
        }));
    }
  }

  const typeToken = spec.typeDefinition?.match(/[A-Za-z_][A-Za-z0-9_.<>]*/)?.[0];
  if (typeToken && typeToken.length > 2 && !added.includes(typeToken)) {
    out.push(finding("spec/type_absent", "warn",
      `Declared type "${typeToken}" appears nowhere in the added lines`, { category: "types" }));
  }

  const roles = new Set((spec.allRelatedFiles ?? []).map((f) => f.role));
  for (const role of roles) {
    if (!ROLE_HINTS[role]) continue;
    if (!files.some((f) => ROLE_HINTS[role].test(f.path))) {
      out.push(finding("spec/layer_missing", "warn",
        `Spec lists a "${role}" file but no changed file looks like one`, {
          category: "correctness",
          detail: "Heuristic — the target repo may legitimately organise this layer differently.",
        }));
    }
  }
  return out;
}

const ROLE_HINTS: Record<string, RegExp> = {
  type: /([Tt]ypes?)[^/]*\.res$|\/types\//i,
  parser: /(Parser|Parse|SdkTypes|Utils)[^/]*\.res$/i,
  state: /(Context|Store|Recoil|State)[^/]*\.res$/i,
  component: /\/[Cc]omponents\/|\/pages\//,
};

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// ─── patch applicability ─────────────────────────────────────────────────────

/**
 * Prove the stored .patch exactly and invertibly describes the tree delta.
 *
 * `--reverse`, not plain `--check`: the patch is captured from the dirty
 * worktree, so its changes are already present and a forward check fails by
 * construction. Reverse-applying is the correct round-trip, and it catches
 * truncation, malformed concatenated headers, and hunk counts that disagree
 * with their bodies.
 *
 * Never `--3way`/`--index`: submodule hunks carry blob hashes from the
 * submodule's object database, not the parent's.
 */
export function checkPatchApplies(repoDir: string, patchPath: string): PatchFinding[] {
  if (!fs.existsSync(patchPath)) {
    return [finding("diff/malformed", "reject", `Patch file missing: ${patchPath}`)];
  }
  try {
    execFileSync("git", ["apply", "--check", "--reverse", "--", patchPath], {
      cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return [];
  } catch (err) {
    const e = err as { stderr?: string };
    return [finding("diff/malformed", "reject",
      "Stored patch does not describe the working tree — it will not apply", {
        detail: String(e.stderr ?? "").slice(0, 500),
      })];
  }
}

/**
 * All four path-bearing header lines must agree. They disagreed for submodule
 * diffs until submoduleGit.ts stopped regex-rewriting only `diff --git`, which
 * produced patches that applied to the wrong path and a file-path set with two
 * contradictory entries per file.
 */
export function checkPathHeaders(diff: string): PatchFinding[] {
  const out: PatchFinding[] = [];
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) continue;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("diff --git"); j++) {
      if (lines[j].startsWith("@@")) break;
      const minus = lines[j].match(/^--- (?:a\/)?(.+)$/);
      const plus = lines[j].match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (minus && minus[1] !== "/dev/null" && minus[1] !== m[1]) {
        out.push(finding("diff/path_mismatch", "reject",
          `Header paths disagree: "diff --git a/${m[1]}" vs "--- ${minus[1]}"`, { file: m[2] }));
      }
      if (plus && plus[1] !== "/dev/null" && plus[1] !== m[2]) {
        out.push(finding("diff/path_mismatch", "reject",
          `Header paths disagree: "diff --git b/${m[2]}" vs "+++ ${plus[1]}"`, { file: m[2] }));
      }
    }
  }
  return out;
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export function runPatchValidators(input: {
  diff: string;
  repoDir: string;
  category: string;
  patchPath?: string;
  spec?: SpecLike | null;
  sizeLimits?: SizeLimits;
}): PatchQualityReport {
  const { diff, repoDir, category, patchPath, spec = null, sizeLimits } = input;
  const files = parseDiffFiles(diff);
  const findings: PatchFinding[] = [];

  if (files.length === 0) {
    findings.push(finding("diff/empty", "reject", "Diff contains no file changes"));
  } else {
    findings.push(
      ...checkPathHeaders(diff),
      ...checkDiffScope(files, scopePolicyFor(category)),
      ...checkGeneratedFiles(repoDir, files),
      ...checkDiffSize(files, sizeLimits),
      ...checkDebugResidue(files),
      ...checkSpecCoverage(files, spec, category),
    );
    if (patchPath) findings.push(...checkPatchApplies(repoDir, patchPath));
  }

  return {
    findings,
    rejected: findings.some((f) => f.level === "reject"),
    stats: {
      files: files.length,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    },
    ranAt: new Date().toISOString(),
  };
}

/**
 * Final verdict. The model's own `pass` is deliberately ignored, exactly as
 * `computeVerdict` in validators.ts ignores a stated review verdict — models
 * have a strong approval bias and will report pass while listing blockers.
 *
 * Unparseable verifier output is `needs_review`, NEVER `pass`. That is the
 * fail-open hole in routes/patches.ts:456-467 this replaces.
 */
export function computePatchVerdict(
  report: PatchQualityReport,
  verifier: { parsed: boolean; issues: string[] },
  criticBlocking = 0,
): "pass" | "needs_review" | "reject" {
  if (report.rejected) return "reject";
  if (!verifier.parsed) return "needs_review";
  if (verifier.issues.length > 0 || criticBlocking > 0) return "needs_review";
  return "pass";
}
