/**
 * Props skill — Add a new configuration prop across both SDKs.
 *
 * Sends one Opus agent per platform target (web, mobile, android_native, ios_native).
 * Each agent gets pattern files from the target repo so it knows exactly how
 * to wire props. Creates git branches per repo and captures diffs.
 *
 * Exports two handlers:
 *  - handlePropsRoute   → used by /props/generate (legacy shape, backward compat)
 *  - handlePropsSkill   → used by /skills/props/generate (SkillEnvelope shape)
 */

import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { PATCHES_DIR, REPOS, type RepoKey } from "../../config.js";
import { ask } from "../../llm.js";
import { saveSkillRun } from "../../db.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";
import { commitWithSubmodules, getDiffWithSubmodules, resetSubmodules, forceCheckoutBranch } from "../submoduleGit.js";
import { pushBranchToFork, pushSubmoduleToFork, rewriteGitmodulesToForks, createPullRequest } from "../githubPr.js";
import { runRescriptBuild } from "../buildCheck.js";

export interface PropSpec {
  propName: string;
  type: string;
  default: string;
  parentConfig?: string;
  behavior: string;
  platforms: string[];
}

// Pattern reference files that teach the agent how props are wired in each repo
const WEB_PATTERN_FILES = [
  "src/Types/PaymentType.res",
  "src/Utilities/DynamicFieldsUtils.res",
  "src/Components/DynamicFields.res",
];

const MOBILE_PATTERN_FILES = [
  "src/types/SdkTypes.res",
  "src/types/NativeSdkPropsKeys.res",
  "src/contexts/DynamicFieldsContext.res",
  "src/components/dynamic/RequiredFields.res",
];

const ANDROID_PATTERN_FILES = [
  "android/hyperswitch-sdk-android-api/src/main/kotlin/io/hyperswitch/paymentsheet/PaymentSheet.kt",
  "android/hyperswitch-sdk-android-api/src/main/kotlin/io/hyperswitch/paymentsession/LaunchOptions.kt",
];

const IOS_PATTERN_FILES = [
  "ios/hyperswitchSDK/Shared/PaymentSheetConfiguration.swift",
];

export function readPatternFile(repoDir: string, relPath: string, maxSize = 12000): string {
  try {
    const full = path.join(repoDir, relPath);
    let content = fs.readFileSync(full, "utf8");
    if (content.length > maxSize) content = content.slice(0, maxSize) + "\n... [truncated]";
    return `### ${relPath}\n\`\`\`\n${content}\n\`\`\``;
  } catch {
    return `### ${relPath}\n(file not found)`;
  }
}

function buildWebPrompt(spec: PropSpec, repoDir: string): string {
  const patterns = WEB_PATTERN_FILES.map((f) => readPatternFile(repoDir, f)).join("\n\n");
  return `You are adding a new configuration prop to the hyperswitch-web (ReScript web SDK) repository.

Your current working directory IS the web repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Prop Specification

- **Name**: ${spec.propName}
- **Type**: ${spec.type}
- **Default**: ${spec.default}
- **Parent config**: ${spec.parentConfig || "top-level options"}
- **Behavior**: ${spec.behavior}

## How props are wired in this repo (FOLLOW THIS PATTERN EXACTLY)

${patterns}

## Instructions

1. First use Glob/Grep to confirm the current code structure matches the patterns above.
2. Add the prop to the type definition (in PaymentType.res or relevant type file).
3. Add parsing in the parser function (follow the existing getBoolWithWarning / getWarningString pattern).
4. Add the default value.
5. Update the unknownKeysWarning array to include the new key.
6. Wire the prop into the component logic that controls the behavior described above.
7. Only touch files that are necessary. Follow existing conventions exactly.

Important:
- This is a ReScript codebase. Use ReScript syntax.
- Follow the EXACT naming conventions used in this repo (camelCase for ReScript fields).
- Look at how similar props (like hideExpiredPaymentMethods, displaySavedPaymentMethods) are wired as examples.

After implementing, output ONLY a JSON summary (no code fences):
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}], "backward_compatible": true, "notes": "<any caveats>"}`;
}

function buildMobilePrompt(spec: PropSpec, repoDir: string): string {
  const patterns = MOBILE_PATTERN_FILES.map((f) => readPatternFile(repoDir, f)).join("\n\n");
  return `You are adding a new configuration prop to the hyperswitch-client-core (ReScript mobile SDK) repository.

Your current working directory IS the mobile repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Prop Specification

- **Name**: ${spec.propName}
- **Type**: ${spec.type}
- **Default**: ${spec.default}
- **Parent config**: ${spec.parentConfig || "configurationType"}
- **Behavior**: ${spec.behavior}

## How props are wired in this repo (FOLLOW THIS PATTERN EXACTLY)

${patterns}

## Instructions

1. First use Glob/Grep to understand how existing config props flow through the codebase.
2. Add the prop to \`configurationType\` in SdkTypes.res.
3. Add parsing in \`parseConfigurationDict\` to extract from the native props dict.
4. Add key mappings in NativeSdkPropsKeys.res for android, ios, and rn keys.
5. Wire the prop into the component logic that controls the behavior described above.
6. The prop flows: Native config → Bundle/Dict → SdkTypes.configurationType → NativePropContext → Components.
7. Only touch files that are necessary.

Important:
- This is a ReScript codebase. Use ReScript syntax.
- Follow the EXACT naming conventions used in this repo.
- Look at how similar props (like hideExpiredPaymentMethods, displayDefaultSavedPaymentIcon) are wired.

After implementing, output ONLY a JSON summary (no code fences):
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}], "backward_compatible": true, "notes": "<any caveats>"}`;
}

function buildAndroidPrompt(spec: PropSpec, repoDir: string): string {
  const patterns = ANDROID_PATTERN_FILES.map((f) => readPatternFile(repoDir, f)).join("\n\n");
  return `You are adding a new configuration prop to the Android native layer of hyperswitch-client-core.

Your current working directory IS the mobile repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Prop Specification

- **Name**: ${spec.propName}
- **Type**: ${spec.type} (Kotlin equivalent: ${spec.type === "bool" ? "Boolean" : spec.type === "string" ? "String" : spec.type})
- **Default**: ${spec.default}
- **Behavior**: ${spec.behavior}

## How Android native props are wired (FOLLOW THIS PATTERN EXACTLY)

${patterns}

## Instructions

1. Add the prop to the \`Configuration\` data class in PaymentSheet.kt.
2. Add Bundle serialization in the \`.bundle\` computed property.
3. Ensure it's passed through in LaunchOptions.kt if needed.
4. Follow the exact pattern of existing props like \`defaultBillingDetails\`, \`displayDefaultSavedPaymentIcon\`.
5. Only touch Kotlin files in the android/ directory.

After implementing, output ONLY a JSON summary (no code fences):
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}], "backward_compatible": true, "notes": "<any caveats>"}`;
}

function buildIosPrompt(spec: PropSpec, repoDir: string): string {
  const patterns = IOS_PATTERN_FILES.map((f) => readPatternFile(repoDir, f)).join("\n\n");
  return `You are adding a new configuration prop to the iOS native layer of hyperswitch-client-core.

Your current working directory IS the mobile repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Prop Specification

- **Name**: ${spec.propName}
- **Type**: ${spec.type} (Swift equivalent: ${spec.type === "bool" ? "Bool" : spec.type === "string" ? "String" : spec.type})
- **Default**: ${spec.default}
- **Behavior**: ${spec.behavior}

## How iOS native props are wired (FOLLOW THIS PATTERN EXACTLY)

${patterns}

## Instructions

1. Add the prop to the \`Configuration\` struct in PaymentSheetConfiguration.swift.
2. Add dictionary serialization in the \`toDictionary()\` method.
3. Follow the exact pattern of existing props.
4. Only touch Swift files in the ios/ directory.

After implementing, output ONLY a JSON summary (no code fences):
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}], "backward_compatible": true, "notes": "<any caveats>"}`;
}

export async function runPropAgent(
  repoKey: RepoKey,
  slug: string,
  spec: PropSpec,
  buildPrompt: (spec: PropSpec, repoDir: string) => string,
): Promise<SkillRepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const git = simpleGit(repoDir);
  const branchName = `feat/prop-${slug}`;

  // Reset submodules to clean state before branching
  await resetSubmodules(repoDir, repoKey);
  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";

  try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  await git.checkoutLocalBranch(branchName);

  const prompt = buildPrompt(spec, repoDir);
  const summary = await ask(prompt, {
    model: "opus",
    timeoutMs: 600_000,
    cwd: repoDir,
    allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
  });

  // Submodule-aware diff: excludes dirty submodule pointer noise,
  // captures real file changes from both parent and submodules
  const { diff, fileCount } = await getDiffWithSubmodules(repoDir, repoKey);

  if (!diff || fileCount === 0) {
    await forceCheckoutBranch(repoDir, repoKey, defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Opus did not produce any file changes");
  }

  // Always write the .patch file so the user can inspect even on build failure
  const patchPath = path.join(PATCHES_DIR, `prop-${slug}-${repoKey}.patch`);
  fs.writeFileSync(patchPath, diff);

  // Mandatory ReScript build check before committing. If the agent's edits
  // don't compile, the change is fundamentally broken and we refuse to commit.
  const build = runRescriptBuild(repoDir);
  if (!build.passed) {
    await forceCheckoutBranch(repoDir, repoKey, defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error(
      `ReScript build failed in ${repoKey} — prop changes rejected. Build output (tail):\n${build.log}`,
    );
  }

  // Commit inside submodules first (if any changes there), then parent
  const commitMsg = `feat: add ${spec.propName} prop\n\nGenerated by feature-gap-dashboard prop skill`;
  const commitResult = await commitWithSubmodules(repoDir, repoKey, commitMsg);

  // Push to fork + open PR inside the bot's own fork
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let prWarning: string | null = null;
  try {
    for (const subDir of commitResult.submodulesChanged) {
      await pushSubmoduleToFork({ parentDir: repoDir, subDir, branchName });
    }
    if (commitResult.submodulesChanged.length > 0) {
      const rewritten = rewriteGitmodulesToForks(repoDir, commitResult.submodulesChanged);
      if (rewritten.length > 0) {
        const sg = simpleGit(repoDir);
        await sg.add([".gitmodules"]);
        await sg.commit("chore: point submodules at bot forks for build");
      }
    }
    await pushBranchToFork(repoDir, repoKey, branchName);
    const pr = await createPullRequest({
      repoKey,
      branch: branchName,
      title: `feat: add ${spec.propName} prop`,
      body: `## Add Prop: \`${spec.propName}\`\n\nType: \`${spec.type}\`, Default: \`${spec.default}\`\n\n${summary.slice(0, 1000)}\n\n---\n*Generated by feature-gap-dashboard prop skill*`,
    });
    prUrl = pr.prUrl;
    prNumber = pr.prNumber;
  } catch (err) {
    prWarning = `PR creation failed: ${(err as Error).message}`;
  }

  await forceCheckoutBranch(repoDir, repoKey, defaultBranch);

  return {
    repo: repoKey,
    branch: branchName,
    summary: summary.slice(0, 3000),
    diff,
    filesTouched: fileCount,
    prUrl,
    prNumber,
    prWarning,
  };
}

export async function runMobilePropAgent(
  slug: string,
  spec: PropSpec,
  platforms: string[],
): Promise<SkillRepoResult> {
  const repoDir = REPOS.mobile.dir;
  const git = simpleGit(repoDir);
  const branchName = `feat/prop-${slug}`;

  // Reset submodules to clean state before branching
  await resetSubmodules(repoDir, "mobile");
  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";

  try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  await git.checkoutLocalBranch(branchName);

  const summaries: string[] = [];

  // Run each agent — they edit files on disk via Edit/Write tools.
  // Don't git-add between agents; we'll handle all staging at the end
  // using submodule-aware operations.
  if (platforms.includes("mobile")) {
    const s = await ask(buildMobilePrompt(spec, repoDir), {
      model: "opus", timeoutMs: 600_000, cwd: repoDir,
      allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
    });
    summaries.push(s);
  }

  if (platforms.includes("android_native")) {
    const s = await ask(buildAndroidPrompt(spec, repoDir), {
      model: "opus", timeoutMs: 600_000, cwd: repoDir,
      allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
    });
    summaries.push(s);
  }

  if (platforms.includes("ios_native")) {
    const s = await ask(buildIosPrompt(spec, repoDir), {
      model: "opus", timeoutMs: 600_000, cwd: repoDir,
      allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
    });
    summaries.push(s);
  }

  // Collect diffs from parent + all submodules (android/, ios/, shared-code/)
  const { diff, fileCount } = await getDiffWithSubmodules(repoDir, "mobile");

  if (!diff || fileCount === 0) {
    await forceCheckoutBranch(repoDir, "mobile", defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Opus did not produce any file changes");
  }

  // Always write the .patch file so the user can inspect even on build failure
  const patchPath = path.join(PATCHES_DIR, `prop-${slug}-mobile.patch`);
  fs.writeFileSync(patchPath, diff);

  // Mandatory ReScript build check across all three layers (ReScript shared,
  // Android native, iOS native). The ReScript build catches breakage in the
  // shared-code layer; native layers will be caught later by their own build
  // tooling, but the rescript pass is the cheapest and catches the most
  // common agent mistake (missing module / wrong type).
  const build = runRescriptBuild(repoDir);
  if (!build.passed) {
    await forceCheckoutBranch(repoDir, "mobile", defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error(
      `ReScript build failed in mobile — prop changes rejected. Build output (tail):\n${build.log}`,
    );
  }

  // Commit inside each submodule first, then parent — handles android/, ios/, shared-code/
  const commitMsg = `feat: add ${spec.propName} prop (ReScript + native layers)\n\nGenerated by feature-gap-dashboard prop skill`;
  const commitResult = await commitWithSubmodules(repoDir, "mobile", commitMsg);

  // Push to fork + open PR
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let prWarning: string | null = null;
  try {
    for (const subDir of commitResult.submodulesChanged) {
      await pushSubmoduleToFork({ parentDir: repoDir, subDir, branchName });
    }
    if (commitResult.submodulesChanged.length > 0) {
      const rewritten = rewriteGitmodulesToForks(repoDir, commitResult.submodulesChanged);
      if (rewritten.length > 0) {
        const sg = simpleGit(repoDir);
        await sg.add([".gitmodules"]);
        await sg.commit("chore: point submodules at bot forks for build");
      }
    }
    await pushBranchToFork(repoDir, "mobile", branchName);
    const pr = await createPullRequest({
      repoKey: "mobile",
      branch: branchName,
      title: `feat: add ${spec.propName} prop (mobile)`,
      body: `## Add Prop: \`${spec.propName}\` (mobile)\n\n${summaries.join("\n\n").slice(0, 1500)}\n\n---\n*Generated by feature-gap-dashboard prop skill*`,
    });
    prUrl = pr.prUrl;
    prNumber = pr.prNumber;
  } catch (err) {
    prWarning = `PR creation failed: ${(err as Error).message}`;
  }

  await forceCheckoutBranch(repoDir, "mobile", defaultBranch);

  return {
    repo: "mobile",
    branch: branchName,
    summary: summaries.join("\n---\n").slice(0, 5000),
    diff,
    filesTouched: fileCount,
    prUrl,
    prNumber,
    prWarning,
  };
}

/** Shared logic: run the prop agents and return results keyed by repo. */
async function runProps(spec: PropSpec): Promise<{ propName: string; results: Record<string, SkillRepoResult> }> {
  const slug = spec.propName
    .replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40).replace(/-$/, "");

  const results: Record<string, SkillRepoResult> = {};
  const webPlatforms = spec.platforms.filter((p) => p === "web");
  const mobilePlatforms = spec.platforms.filter((p) =>
    ["mobile", "android_native", "ios_native"].includes(p),
  );

  if (webPlatforms.length > 0) {
    try {
      results.web = await runPropAgent("web", slug, spec, buildWebPrompt);
    } catch (err) {
      results.web = { repo: "web", branch: "", summary: "", diff: "", filesTouched: 0, error: (err as Error).message };
    }
  }

  if (mobilePlatforms.length > 0) {
    try {
      results.mobile = await runMobilePropAgent(slug, spec, mobilePlatforms);
    } catch (err) {
      results.mobile = { repo: "mobile", branch: "", summary: "", diff: "", filesTouched: 0, error: (err as Error).message };
    }
  }

  return { propName: spec.propName, results };
}

/** Handler for legacy POST /props/generate — returns original shape. */
export async function handlePropsRoute(req: Request, res: Response): Promise<void> {
  const spec = req.body as PropSpec;
  if (!spec.propName || !spec.behavior || !spec.platforms?.length) {
    res.status(400).json({ error: "propName, behavior, and platforms are required" });
    return;
  }
  const { propName, results } = await runProps(spec);
  res.json({ propName, results });
}

/** Handler for POST /skills/props/generate — returns SkillEnvelope shape. */
export async function handlePropsSkill(req: Request, res: Response): Promise<void> {
  const spec = req.body as PropSpec;
  if (!spec.propName || !spec.behavior || !spec.platforms?.length) {
    res.status(400).json({ error: "propName, behavior, and platforms are required" });
    return;
  }
  try {
    const { propName, results } = await runProps(spec);
    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "props",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
      meta: { propName },
    };
    const runId = saveSkillRun("props", envelope.status, JSON.stringify(spec), JSON.stringify(envelope));
    envelope.meta = { ...envelope.meta, runId };
    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/** Handler for GET /props — list all prop patch files. */
export function handlePropsList(_req: Request, res: Response): void {
  try {
    const files = fs.readdirSync(PATCHES_DIR).filter((f) => f.startsWith("prop-"));
    res.json(files.map((f) => ({ file: f, path: path.join(PATCHES_DIR, f) })));
  } catch {
    res.json([]);
  }
}
