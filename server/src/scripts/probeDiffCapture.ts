/**
 * Regression probe for the two diff-capture bugs in skills/submoduleGit.ts.
 *
 *   Bug A — `git diff` shows only unstaged changes to TRACKED files, so a
 *           newly created file (the common case when the patch agent uses
 *           Write) was absent from the stored .patch and from files_touched,
 *           even though commitWithSubmodules staged and committed it.
 *
 *   Bug B — the hand-rolled untracked-file synthesizer built hunk headers from
 *           `content.split("\n")`, which leaves a trailing "" for newline-
 *           terminated files. Every synthesized hunk overcounted by one line
 *           and emitted a spurious trailing `+`, so the patch did not
 *           round-trip through `git apply`.
 *
 * Run:  npx tsx server/src/scripts/probeDiffCapture.ts
 *
 * Builds throwaway git repos in a temp dir; touches nothing in the workspace.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDiffWithSubmodules } from "../skills/submoduleGit.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * For every `@@ -a,b +c,d @@` hunk, compare the declared old/new line counts
 * against the lines the hunk body actually carries. Returns human-readable
 * descriptions of any hunk where they disagree.
 *
 * Note `@@ -0,0 +1 @@` is valid — git omits the count when it is 1.
 */
function hunkCountMismatches(diff: string): string[] {
  const out: string[] = [];
  let header: { line: string; oldN: number; newN: number } | null = null;
  let oldSeen = 0;
  let newSeen = 0;

  const flush = () => {
    if (!header) return;
    if (oldSeen !== header.oldN || newSeen !== header.newN) {
      out.push(
        `${header.line} — declared -${header.oldN}/+${header.newN}, body has -${oldSeen}/+${newSeen}`,
      );
    }
    header = null;
  };

  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      flush();
      header = {
        line,
        oldN: m[2] === undefined ? 1 : Number(m[2]),
        newN: m[4] === undefined ? 1 : Number(m[4]),
      };
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (!header) continue;
    if (line.startsWith("diff --git")) { flush(); continue; }
    if (line.startsWith("\\")) continue;          // "\ No newline at end of file"
    if (line.startsWith("+")) { newSeen++; continue; }
    if (line.startsWith("-")) { oldSeen++; continue; }
    if (line.startsWith(" ")) { oldSeen++; newSeen++; continue; }
  }
  flush();
  return out;
}

/**
 * Reconstruct the content a diff claims a newly-added file should have, by
 * concatenating the `+` lines of its `new file` hunk.
 *
 * This is the assertion that actually pins Bug B. The old synthesizer's hunk
 * header was self-consistent with its body — `"x\n".split("\n")` yields
 * `["x", ""]`, so it declared 2 lines AND emitted 2 `+` lines — but the second
 * was a phantom blank line that does not exist in the file. Only comparing the
 * reconstruction against the real bytes catches that.
 *
 * Returns null when the diff has no new-file hunk for `filePath`.
 */
function reconstructAddedFile(diff: string, filePath: string): string | null {
  const lines = diff.split("\n");
  const start = lines.findIndex((l) => l === `+++ b/${filePath}`);
  if (start < 0) return null;

  const body: string[] = [];
  let noEol = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\")) { noEol = true; continue; }   // \ No newline at end of file
    if (line.startsWith("diff --git")) break;
    if (line.startsWith("+")) { body.push(line.slice(1)); continue; }
    break;
  }
  return body.join("\n") + (noEol ? "" : "\n");
}

/**
 * A diff has four path-bearing header lines. Report every file section where
 * `diff --git a/X b/Y` disagrees with its `--- a/X` / `+++ b/Y` lines.
 *
 * This pins the submodule path-prefixing bug: rewriting only the `diff --git`
 * line left `+++ b/SubNew.res` where `+++ b/shared-code/SubNew.res` belonged,
 * producing a patch that applies to the wrong path and a file-path set
 * (`extractDiffFilePaths`) containing two contradictory entries per file.
 */
function pathHeaderMismatches(diff: string): string[] {
  const out: string[] = [];
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) continue;
    const [, aPath, bPath] = m;
    let minus: string | null = null;
    let plus: string | null = null;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("diff --git"); j++) {
      const mm = lines[j].match(/^--- (?:a\/)?(.+)$/);
      const pp = lines[j].match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (mm && minus === null) minus = mm[1];
      if (pp && plus === null) plus = pp[1];
      if (lines[j].startsWith("@@")) break;
    }
    if (minus !== null && minus !== "/dev/null" && minus !== aPath) {
      out.push(`${lines[i]} — "--- ${minus}" should be "--- a/${aPath}"`);
    }
    if (plus !== null && plus !== "/dev/null" && plus !== bPath) {
      out.push(`${lines[i]} — "+++ ${plus}" should be "+++ b/${bPath}"`);
    }
  }
  return out;
}

/** Init a repo with one committed file. */
function initRepo(dir: string, seedName = "seed.res"): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "probe@local");
  git(dir, "config", "user.name", "probe");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, seedName), "let existing = 1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-diff-probe-"));
  console.log(`probe root: ${root}\n`);

  // ── Case A — parent repo only: untracked + modified + staged, full round-trip
  console.log("Case A — parent repo (untracked + modified + staged)");
  const parent = path.join(root, "parent");
  initRepo(parent);

  fs.writeFileSync(path.join(parent, "seed.res"), "let existing = 2\n");        // modified
  fs.writeFileSync(path.join(parent, "NewFeature.res"), "let added = true\n");  // untracked, newline-terminated
  fs.writeFileSync(path.join(parent, "NoEol.res"), "let noEol = true");         // untracked, NO trailing newline
  fs.writeFileSync(path.join(parent, "Staged.res"), "let staged = 1\n");        // untracked then staged
  git(parent, "add", "--", "Staged.res");

  // repoKey "web" => SUBMODULE_DIRS.web = ["shared-code"], absent here, so parent-only.
  const a = await getDiffWithSubmodules(parent, "web");

  check("modified tracked file present", a.diff.includes("b/seed.res"));
  check("untracked new file present (Bug A)", a.diff.includes("b/NewFeature.res"),
    a.diff || "(empty diff)");
  check("untracked no-EOL file present", a.diff.includes("b/NoEol.res"));
  check("already-staged file present", a.diff.includes("b/Staged.res"));
  check("fileCount === 4", a.fileCount === 4, `got ${a.fileCount}`);
  check("new file rendered as `new file mode` by git", a.diff.includes("new file mode"));
  check("no-EOL marker emitted", a.diff.includes("\\ No newline at end of file"));

  // Bug B specifically: every hunk header's declared line count must equal the
  // number of lines the hunk actually carries. The old synthesizer overcounted
  // by one for newline-terminated files and emitted a spurious trailing `+`.
  const mismatches = hunkCountMismatches(a.diff);
  check("every hunk header count matches its body (Bug B)", mismatches.length === 0,
    mismatches.join("\n"));
  check("no spurious trailing empty addition (Bug B)", !/\+let added = true\n\+\n/.test(a.diff));

  // Round-trip: the patch must invertibly describe the tree delta.
  const patchPath = path.join(root, "a.patch");
  fs.writeFileSync(patchPath, a.diff.endsWith("\n") ? a.diff : a.diff + "\n");
  let applyErr = "";
  try {
    git(parent, "apply", "--check", "--reverse", "--", patchPath);
  } catch (err) {
    applyErr = String((err as { stderr?: Buffer }).stderr ?? err);
  }
  check("git apply --check --reverse succeeds", applyErr === "", applyErr);

  // The index must be exactly as we left it (intent-to-add markers undone).
  const porcelain = git(parent, "status", "--porcelain");
  check("Staged.res still staged (index restored)", /^A  Staged\.res$/m.test(porcelain), porcelain);
  check("NewFeature.res still untracked (index restored)", /^\?\? NewFeature\.res$/m.test(porcelain), porcelain);

  // ── Case B — submodule changes are captured too
  console.log("\nCase B — submodule (untracked + modified inside shared-code)");
  const subOrigin = path.join(root, "sub-origin");
  initRepo(subOrigin, "SubSeed.res");
  const parent2 = path.join(root, "parent2");
  initRepo(parent2);
  git(parent2, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, "shared-code");
  git(parent2, "commit", "-q", "-m", "add submodule");

  const subDir = path.join(parent2, "shared-code");
  fs.writeFileSync(path.join(subDir, "SubSeed.res"), "let existing = 99\n");     // modified in sub
  fs.writeFileSync(path.join(subDir, "SubNew.res"), "let subAdded = true\n");    // untracked in sub
  fs.writeFileSync(path.join(parent2, "ParentNew.res"), "let parentAdded = 1\n"); // untracked in parent

  const b = await getDiffWithSubmodules(parent2, "web");

  check("submodule modified file present", b.diff.includes("b/shared-code/SubSeed.res"), b.diff);
  check("submodule untracked file present (Bug A)", b.diff.includes("b/shared-code/SubNew.res"), b.diff);
  check("parent untracked file present", b.diff.includes("b/ParentNew.res"));
  check("submodule pointer noise excluded", !b.diff.includes("Subproject commit"));
  check("fileCount === 3", b.fileCount === 3, `got ${b.fileCount}`);

  // Bug B lived in the submodule path specifically — the hand-rolled
  // synthesizer only ever ran for untracked files inside a submodule.
  const subMismatches = hunkCountMismatches(b.diff);
  check("every submodule hunk header count matches its body (Bug B)",
    subMismatches.length === 0, subMismatches.join("\n"));
  check("submodule new file rendered as `new file mode` by git",
    b.diff.includes("new file mode"), b.diff);

  const claimed = reconstructAddedFile(b.diff, "shared-code/SubNew.res");
  const actual = fs.readFileSync(path.join(subDir, "SubNew.res"), "utf8");
  check("submodule new file reconstructs byte-exactly (Bug B)", claimed === actual,
    `claimed ${JSON.stringify(claimed)} vs actual ${JSON.stringify(actual)}`);

  // Bug C — all four path-bearing header lines must agree, in both repos.
  const pathBugsA = pathHeaderMismatches(a.diff);
  check("parent diff header paths agree (Bug C)", pathBugsA.length === 0, pathBugsA.join("\n"));
  const pathBugsB = pathHeaderMismatches(b.diff);
  check("submodule diff header paths agree (Bug C)", pathBugsB.length === 0, pathBugsB.join("\n"));
  check("submodule --- / +++ lines are re-rooted under shared-code/ (Bug C)",
    b.diff.includes("+++ b/shared-code/SubSeed.res"), b.diff);

  const subPorcelain = git(subDir, "status", "--porcelain");
  check("submodule index restored", /^\?\? SubNew\.res$/m.test(subPorcelain), subPorcelain);

  console.log(
    failures === 0
      ? `\nAll checks passed. (${root} left in place for inspection)`
      : `\n${failures} check(s) FAILED. Probe tree: ${root}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
