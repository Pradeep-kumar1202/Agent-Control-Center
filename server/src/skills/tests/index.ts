/**
 * Test Writer skill — Given a branch and feature description, write Cypress
 * (web) and Detox (mobile) e2e tests following each repo's existing patterns.
 *
 * Flow:
 *  1. Fetch the PR diff (read-only, before creating test branch)
 *  2. Read existing test pattern files to embed in the prompt
 *  3. Run Opus agent with Edit/Write/Read/Glob/Grep tools to write the tests
 *  4. Commit on a feature branch and return the diff
 */

import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { PATCHES_DIR, REPOS } from "../../config.js";
import { ask } from "../../llm.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";

export interface TestWriterSpec {
  branch: string;
  repo: "web" | "mobile" | "both";
  featureDescription: string;
  baseBranch?: string;
}

function readFile(filePath: string, maxSize = 10000): string {
  try {
    let content = fs.readFileSync(filePath, "utf8");
    if (content.length > maxSize) content = content.slice(0, maxSize) + "\n... [truncated]";
    return content;
  } catch {
    return "(file not found)";
  }
}

async function getPrDiff(repoDir: string, branch: string, baseBranch: string): Promise<string> {
  try {
    const git = simpleGit(repoDir);
    let resolvedBranch = branch;

    // Handle GitHub PR URLs: https://github.com/org/repo/pull/123
    if (branch.startsWith("https://github.com") || branch.startsWith("http://github.com")) {
      const prMatch = branch.match(/\/pull\/(\d+)/);
      if (prMatch) {
        const prNum = prMatch[1];
        try {
          // Fetch to FETCH_HEAD — no local ref, no conflicts on re-run
          await git.raw(["fetch", "origin", `pull/${prNum}/head`]);
          resolvedBranch = "FETCH_HEAD";
        } catch {
          // Could not fetch — fall back to empty diff
          return "";
        }
      }
    } else {
      // Try local branch first, then fetch from origin
      const branches = await git.branch(["-a"]);
      const exists = branches.all.some((b) => b.replace("remotes/origin/", "").trim() === resolvedBranch);
      if (!exists) {
        try {
          await git.fetch("origin", resolvedBranch);
        } catch {
          // Branch may not exist on remote — continue with empty diff
        }
      }
    }

    // Three-dot diff preferred; two-dot fallback for shallow clones (no merge base)
    try {
      return await git.diff([`${baseBranch}...${resolvedBranch}`]);
    } catch {
      return await git.diff([`${baseBranch}..${resolvedBranch}`]);
    }
  } catch {
    return "";
  }
}

async function runWebTestAgent(spec: TestWriterSpec): Promise<SkillRepoResult> {
  const repoDir = REPOS.web.dir;
  const git = simpleGit(repoDir);
  const baseBranch = spec.baseBranch ?? "main";
  const slug = spec.branch.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40).replace(/-$/, "");
  const branchName = `feat/tests-${slug}-web`;

  // 1. Read the PR diff before checking out test branch
  const prDiff = await getPrDiff(repoDir, spec.branch, baseBranch);

  // 2. Read pattern files
  const patternTest = readFile(path.join(repoDir, "cypress-tests/cypress/e2e/01-sdk-core/sdk-initialization-test.cy.ts"));
  const patternUtils = readFile(path.join(repoDir, "cypress-tests/cypress/support/utils.ts"));
  const patternCommands = readFile(path.join(repoDir, "cypress-tests/cypress/support/commands.ts"), 5000);
  const patternCards = readFile(path.join(repoDir, "cypress-tests/cypress/support/cards.ts"), 5000);

  // 3. Prepare test branch
  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";
  try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  await git.checkoutLocalBranch(branchName);

  const prompt = `You are writing Cypress e2e tests for a new feature in the hyperswitch-web repository.

Your current working directory IS the web repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Feature Branch: ${spec.branch}
## Feature Description
${spec.featureDescription}

## PR Diff (what changed in the feature branch)
\`\`\`diff
${prDiff || "(diff unavailable — write tests based on feature description)"}
\`\`\`

## Existing Test Patterns — FOLLOW THESE EXACTLY

### sdk-initialization-test.cy.ts (reference test structure)
\`\`\`typescript
${patternTest}
\`\`\`

### support/utils.ts (helpers available to tests)
\`\`\`typescript
${patternUtils}
\`\`\`

### support/commands.ts (custom Cypress commands)
\`\`\`typescript
${patternCommands}
\`\`\`

### support/cards.ts (card fixtures)
\`\`\`typescript
${patternCards}
\`\`\`

## Instructions

1. Use Glob to explore cypress-tests/cypress/e2e/ and identify the right numbered folder for this feature type:
   - 01-sdk-core/: SDK initialization, lifecycle, error handling
   - 02-cards/: Card payment flows (3DS, non-3DS, validation)
   - 03-bank-transfers/: Bank transfer payment methods
   - 04-alternative-payments/: Wallets, BNPL, vouchers
   - 05-external-3ds/: External 3DS flows

2. Create a new .cy.ts file in the appropriate folder. Name it descriptively (e.g., "02-${slug}.cy.ts").

3. Write tests covering:
   - Happy path: successful flow
   - Validation errors: invalid inputs
   - Edge cases based on the diff (empty states, error states)

4. Follow the EXACT patterns from the reference test:
   - Use describe/it blocks
   - Use cy.createPaymentIntent(secretKey, ...) to create payment intents
   - Use cy.getGlobalState("clientSecret") to get client secret
   - Use cy.visit(getClientURL(clientSecret, publishableKey))
   - Access the payment iframe via #orca-payment-element-iframeRef-orca-elements-payment-element-payment-element
   - Import helpers from "../support/utils" and "../support/cards"

5. Use environment variables:
   - Cypress.env("HYPERSWITCH_PUBLISHABLE_KEY")
   - Cypress.env("HYPERSWITCH_SECRET_KEY")

After writing the test file(s), output ONLY a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what the tests cover>"}], "notes": "<any caveats or assumptions made>"}`;

  const summary = await ask(prompt, {
    model: "sonnet",
    timeoutMs: 600_000,
    cwd: repoDir,
    allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
  });

  const diff = await git.diff();
  const diffStat = await git.diffSummary();

  if (!diff || diffStat.files.length === 0) {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Agent did not produce any test files");
  }

  const patchPath = path.join(PATCHES_DIR, `tests-${slug}-web.patch`);
  fs.writeFileSync(patchPath, diff);

  await git.add(".");
  await git.commit(`test: add e2e tests for ${spec.branch}\n\nGenerated by feature-gap-dashboard test-writer skill`);
  await git.checkout(defaultBranch);

  return {
    repo: "web",
    branch: branchName,
    summary: summary.slice(0, 3000),
    diff,
    filesTouched: diffStat.files.length,
  };
}

async function runMobileTestAgent(spec: TestWriterSpec): Promise<SkillRepoResult> {
  const repoDir = REPOS.mobile.dir;
  const git = simpleGit(repoDir);
  const baseBranch = spec.baseBranch ?? "main";
  const slug = spec.branch.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40).replace(/-$/, "");
  const branchName = `feat/tests-${slug}-mobile`;

  const prDiff = await getPrDiff(repoDir, spec.branch, baseBranch);

  const patternTest = readFile(path.join(repoDir, "detox-tests/e2e/card-validation-e2e.test.ts"));
  const patternHelpers = readFile(path.join(repoDir, "detox-tests/utils/DetoxHelpers.ts"));
  const patternConstants = readFile(path.join(repoDir, "detox-tests/fixtures/Constants.ts"), 5000);
  const patternApiUtils = readFile(path.join(repoDir, "detox-tests/utils/APIUtils.ts"), 5000);

  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";
  try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  await git.checkoutLocalBranch(branchName);

  const prompt = `You are writing Detox e2e tests for a new feature in the hyperswitch-client-core repository.

Your current working directory IS the mobile repo: ${repoDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Feature Branch: ${spec.branch}
## Feature Description
${spec.featureDescription}

## PR Diff (what changed in the feature branch)
\`\`\`diff
${prDiff || "(diff unavailable — write tests based on feature description)"}
\`\`\`

## Existing Test Patterns — FOLLOW THESE EXACTLY

### card-validation-e2e.test.ts (reference Detox test)
\`\`\`typescript
${patternTest}
\`\`\`

### utils/DetoxHelpers.ts (helper functions)
\`\`\`typescript
${patternHelpers}
\`\`\`

### fixtures/Constants.ts (test constants and fixtures)
\`\`\`typescript
${patternConstants}
\`\`\`

### utils/APIUtils.ts (API test utilities)
\`\`\`typescript
${patternApiUtils}
\`\`\`

## Instructions

1. Create a new test file in detox-tests/e2e/ named descriptively (e.g., "${slug}-flow.test.ts").

2. Write async Jest/Detox tests covering:
   - Happy path: successful flow
   - Validation errors: invalid inputs
   - Edge cases based on the diff

3. Follow the EXACT patterns from the reference test:
   - Use describe/it (async) blocks
   - Use beforeAll with device.launchApp({ newInstance: true })
   - Use element(by.id(testIds.xxx)) for element selection
   - Use await waitForDemoAppLoad(), await launchPaymentSheet() from DetoxHelpers
   - Import helpers from "../utils/DetoxHelpers"
   - Import constants from "../fixtures/Constants"
   - Handle both iOS and Android platform differences where needed

4. Use TIMEOUT_CONFIG for all timeouts:
   - TIMEOUT_CONFIG.BASE.DEFAULT (15000ms)
   - TIMEOUT_CONFIG.BASE.LONG (30000ms)

5. Use CreateBody from APIUtils to create payment intent bodies.

After writing the test file(s), output ONLY a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what the tests cover>"}], "notes": "<any caveats or assumptions made>"}`;

  const summary = await ask(prompt, {
    model: "sonnet",
    timeoutMs: 600_000,
    cwd: repoDir,
    allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
  });

  const diff = await git.diff();
  const diffStat = await git.diffSummary();

  if (!diff || diffStat.files.length === 0) {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Agent did not produce any test files");
  }

  const patchPath = path.join(PATCHES_DIR, `tests-${slug}-mobile.patch`);
  fs.writeFileSync(patchPath, diff);

  await git.add(".");
  await git.commit(`test: add e2e tests for ${spec.branch}\n\nGenerated by feature-gap-dashboard test-writer skill`);
  await git.checkout(defaultBranch);

  return {
    repo: "mobile",
    branch: branchName,
    summary: summary.slice(0, 3000),
    diff,
    filesTouched: diffStat.files.length,
  };
}

export async function handleTestsSkill(req: Request, res: Response): Promise<void> {
  const spec = req.body as TestWriterSpec;
  if (!spec.branch || !spec.featureDescription || !spec.repo) {
    res.status(400).json({ error: "branch, featureDescription, and repo are required" });
    return;
  }

  const results: Record<string, SkillRepoResult> = {};

  try {
    if (spec.repo === "web" || spec.repo === "both") {
      try {
        results.web = await runWebTestAgent(spec);
      } catch (err) {
        results.web = { repo: "web", branch: "", summary: "", diff: "", filesTouched: 0, error: (err as Error).message };
      }
    }

    if (spec.repo === "mobile" || spec.repo === "both") {
      try {
        results.mobile = await runMobileTestAgent(spec);
      } catch (err) {
        results.mobile = { repo: "mobile", branch: "", summary: "", diff: "", filesTouched: 0, error: (err as Error).message };
      }
    }

    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "tests",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
      meta: { branch: spec.branch },
    };
    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
