/**
 * Integration Agent — reads external documentation (payment method specs,
 * flow guides) and implements the integration in the target SDK repo(s).
 *
 * Four-phase streaming pipeline:
 *   Phase 0: Document Analyst — parse doc into structured IntegrationSpec
 *   Phase 1: Codebase Pattern Analyst — find similar integration patterns
 *   Phase 2: Implementer — implement the integration
 *   Phase 3: Verifier — confirm implementation matches spec
 *
 * Endpoint: POST /skills/integration/generate (NDJSON stream)
 */

import type { Request, Response } from "express";
import { REPOS, type RepoKey } from "../../config.js";
import { db, nowIso, saveSkillRun } from "../../db.js";
import { askStream } from "../../llm.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";
import { commitWithSubmodules, getDiffWithSubmodules, resetSubmodules, forceCheckoutBranch } from "../submoduleGit.js";
import { runRescriptBuild } from "../buildCheck.js";
import { pushBranchToFork, createPullRequest, pushSubmoduleToFork, rewriteGitmodulesToForks } from "../githubPr.js";
import { withRepoLock } from "../../workspace/mutex.js";
import { generateDoc } from "../docs/generator.js";
import simpleGit from "simple-git";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntegrationInput {
  documentSource: "text" | "url";
  documentContent: string;
  targetRepos: ("web" | "mobile")[];
  description: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleIntegrationSkill(req: Request, res: Response): Promise<void> {
  const input = req.body as IntegrationInput;
  if (!input.documentContent?.trim()) {
    res.status(400).json({ error: "documentContent is required" });
    return;
  }
  if (!input.targetRepos?.length) {
    res.status(400).json({ error: "targetRepos must include at least one repo" });
    return;
  }

  // Fetch URL content if needed
  let docText = input.documentContent;
  if (input.documentSource === "url") {
    try {
      const resp = await fetch(input.documentContent);
      docText = await resp.text();
    } catch (err) {
      res.status(400).json({ error: `Failed to fetch URL: ${(err as Error).message}` });
      return;
    }
  }

  // Stream response
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function writeLine(obj: unknown): void {
    if (!res.writableEnded) {
      res.write(JSON.stringify(obj) + "\n");
    }
  }

  const results: Record<string, SkillRepoResult> = {};

  try {
    for (const repoKey of input.targetRepos) {
      writeLine({ type: "repo_marker", repo: repoKey });

      const result = await runIntegrationPipeline(repoKey, docText, input.description, writeLine);
      results[repoKey] = result;
    }

    // Build envelope and save
    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "integration",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
    };
    const runId = saveSkillRun("integration", envelope.status, JSON.stringify(input), JSON.stringify(envelope));

    writeLine({ type: "skill_done", envelope: { ...envelope, meta: { runId } } });

    // Fire-and-forget documentation
    for (const [rk, result] of Object.entries(results)) {
      if (!result.error && result.diff) {
        generateDoc({
          sourceType: "integration",
          sourceId: runId,
          skillId: "integration",
          diff: result.diff,
          summary: result.summary,
          featureName: `Integration: ${input.description.slice(0, 60)}`,
          filesChanged: result.diff.split("\n").filter((l) => l.startsWith("diff --git")).map((l) => l.replace(/^diff --git a\//, "").replace(/ b\/.*/, "")),
          repoKey: rk as "web" | "mobile",
        }).catch(() => { /* fire-and-forget */ });
      }
    }
  } catch (err) {
    writeLine({ type: "error", error: (err as Error).message });
  }

  if (!res.writableEnded) res.end();
}

// ─── Per-repo pipeline ───────────────────────────────────────────────────────

async function runIntegrationPipeline(
  repoKey: RepoKey,
  docText: string,
  description: string,
  writeLine: (obj: unknown) => void,
): Promise<SkillRepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const repoName = repoKey === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
  const slug = description.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 40);
  const branchName = `feat/integrate-${slug}-${repoKey}`;

  return withRepoLock(repoKey, async () => {
    try {
      // Checkout main first
      await forceCheckoutBranch(repoDir, repoKey, "main");
      const git = simpleGit(repoDir);
      try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
      await git.checkoutLocalBranch(branchName);

      // ── Phase 0: Document Analysis ──────────────────────────────────
      writeLine({ type: "phase_marker", phase: "reading_docs" });

      let specText = "";
      const docAnalystPrompt = `You are a payment integration document analyst.

Read the following document carefully and extract a structured integration specification.

<document>
${docText.slice(0, 15000)}
</document>

${description ? `Additional context from the user: ${description}` : ""}

Output a JSON object with these fields (output ONLY valid JSON, no markdown fences):
{
  "paymentMethodName": "string — the name of the payment method or flow",
  "flowType": "redirect | iframe | sdk_widget | form | api_only",
  "requiredFields": ["array of field names the user must fill"],
  "apiEndpoints": ["array of API endpoint paths involved"],
  "configProps": ["array of config prop names needed"],
  "uiComponents": ["array of UI component names needed"],
  "behavior": "string — 2-3 sentence description of how it works end-to-end",
  "edgeCases": ["array of edge cases or error scenarios to handle"]
}`;

      await askStream(docAnalystPrompt, {
        model: "opus",
        timeoutMs: 300_000,
      }, (chunk) => {
        writeLine(chunk);
        if (chunk.type === "text") specText += chunk.text;
      });

      let docSpec: Record<string, unknown> | null = null;
      try {
        const match = specText.match(/\{[\s\S]*\}/);
        if (match) docSpec = JSON.parse(match[0]);
      } catch { /* fall back to raw text */ }

      // ── Phase 1: Codebase Pattern Analysis ──────────────────────────
      writeLine({ type: "phase_marker", phase: "analysing" });

      let planText = "";
      const patternPrompt = `You are a ReScript payment SDK architect. You are working in the ${repoName} repository at ${repoDir}.

${docSpec ? `A document analyst extracted this integration spec:\n<spec>\n${JSON.stringify(docSpec, null, 2)}\n</spec>` : `The integration document describes:\n${docText.slice(0, 5000)}`}

Your task:
1. Find the most similar existing payment method integration in this repo using Grep/Glob/Read
2. Study its pattern: which files were touched, what types were added, how the config flows, how components render
3. Map each spec requirement to the codebase pattern

Output a JSON object (no fences):
{
  "referenceMethod": "name of the most similar existing payment method",
  "patternFiles": [{"path": "relative path", "role": "what this file does"}],
  "implementationSteps": ["ordered list of specific changes needed"],
  "typesToAdd": ["type definitions to create"],
  "configKeysToAdd": ["config prop keys to add"]
}`;

      await askStream(patternPrompt, {
        model: "opus",
        cwd: repoDir,
        allowedTools: ["Read", "Glob", "Grep"],
        timeoutMs: 600_000,
      }, (chunk) => {
        writeLine(chunk);
        if (chunk.type === "text") planText += chunk.text;
      });

      let plan: Record<string, unknown> | null = null;
      try {
        const match = planText.match(/\{[\s\S]*\}/);
        if (match) plan = JSON.parse(match[0]);
      } catch { /* fall back */ }

      // ── Phase 2: Implementation ─────────────────────────────────────
      writeLine({ type: "phase_marker", phase: "implementing" });

      const specSection = docSpec
        ? `<integration_spec>\n${JSON.stringify(docSpec, null, 2)}\n</integration_spec>`
        : `<document_summary>\n${docText.slice(0, 5000)}\n</document_summary>`;
      const planSection = plan
        ? `<implementation_plan>\n${JSON.stringify(plan, null, 2)}\n</implementation_plan>`
        : "";

      const implementerPrompt = `You are a senior ReScript developer implementing a payment integration in ${repoName} at ${repoDir}.

${specSection}
${planSection}

Follow the implementation plan exactly. For each step:
1. Read the reference files to understand the pattern
2. Create or edit files following the same pattern
3. After each batch of edits, run: npm run --silent re:build 2>&1 (Bash, timeout 240000)
4. If build fails, read all errors, find root cause, fix, re-run
5. No attempt limit — iterate until green

When build is green, output a one-line summary of what you implemented.`;

      let agentText = "";
      await askStream(implementerPrompt, {
        model: "opus",
        cwd: repoDir,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        timeoutMs: 1_200_000,
      }, (chunk) => {
        writeLine(chunk);
        if (chunk.type === "text") agentText += chunk.text;
      });

      // ── Server-side build gate ──────────────────────────────────────
      const { diff, fileCount } = await getDiffWithSubmodules(repoDir, repoKey);
      if (fileCount === 0) {
        await forceCheckoutBranch(repoDir, repoKey, "main");
        return {
          repo: repoKey,
          branch: branchName,
          diff: "",
          filesTouched: 0,
          summary: "No changes made",
          error: "Agent produced no file changes",
        };
      }

      const build = runRescriptBuild(repoDir);

      // ── Phase 3: Verification ───────────────────────────────────────
      writeLine({ type: "phase_marker", phase: "verifying" });

      let verifyText = "";
      const verifierPrompt = `You are a verifier. Confirm the integration of "${docSpec?.paymentMethodName ?? description}" in ${repoDir}.

${specSection}

Check:
1. All required types exist
2. Config keys are wired
3. Build is green: run \`npm run --silent re:build 2>&1\`
4. No obvious missing pieces from the spec

Output JSON: {pass: boolean, issues: string[]}`;

      await askStream(verifierPrompt, {
        model: "opus",
        cwd: repoDir,
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        timeoutMs: 300_000,
      }, (chunk) => {
        writeLine(chunk);
        if (chunk.type === "text") verifyText += chunk.text;
      });

      // ── Commit & push ───────────────────────────────────────────────
      const { combinedDiff, totalFiles, submodulesChanged } =
        await commitWithSubmodules(repoDir, repoKey, `feat: integrate ${docSpec?.paymentMethodName ?? description}`);

      let prUrl: string | null = null;
      let prNumber: number | null = null;
      let prWarning: string | null = null;

      try {
        for (const sub of submodulesChanged) {
          await pushSubmoduleToFork({ parentDir: repoDir, subDir: sub, branchName });
        }
        if (submodulesChanged.length > 0) {
          await rewriteGitmodulesToForks(repoDir, submodulesChanged);
          const g = simpleGit(repoDir);
          await g.add(".gitmodules");
          await g.commit("chore: point submodules at bot forks for build");
        }
        await pushBranchToFork(repoDir, repoKey, branchName);
        const pr = await createPullRequest({
          repoKey,
          branch: branchName,
          title: `feat: integrate ${docSpec?.paymentMethodName ?? description}`,
          body: `## Integration Agent\n\nIntegrated **${docSpec?.paymentMethodName ?? description}** from external documentation.\n\n${agentText.slice(0, 1000)}`,
        });
        prUrl = pr.prUrl;
        prNumber = pr.prNumber;
      } catch (err) {
        prWarning = `PR creation failed: ${(err as Error).message}`;
      }

      // Cleanup
      await forceCheckoutBranch(repoDir, repoKey, "main");

      return {
        repo: repoKey,
        branch: branchName,
        diff: combinedDiff || diff,
        filesTouched: totalFiles || fileCount,
        summary: agentText.slice(0, 2000),
        prUrl,
        prNumber,
        prWarning,
      };
    } catch (err) {
      try { await forceCheckoutBranch(repoDir, repoKey, "main"); } catch { /* */ }
      return {
        repo: repoKey,
        branch: branchName,
        diff: "",
        filesTouched: 0,
        summary: "",
        error: (err as Error).message,
      };
    }
  });
}
