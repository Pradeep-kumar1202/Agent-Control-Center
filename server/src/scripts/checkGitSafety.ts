/**
 * Regression tests for the two git bugs that broke the PR-port run on
 * hyperswitch-web#1412. Both were silent: no exception, no log, just a patch git
 * refused and a phase that never advanced.
 *
 *  1. CORRUPT PATCH. `diffWorkingTree` trimmed git's output. A unified diff's
 *     context line for a blank source line is a single space, so trimming a hunk
 *     that ends on a blank line removed both that line and the terminating
 *     newline — leaving a patch two lines shorter than its own hunk header
 *     declared. `git apply` rejected it as "corrupt patch at line N".
 *
 *  2. INTERACTIVE HOOK HANG. `hyperswitch-client-core` ships a
 *     `prepare-commit-msg` hook that execs an interactive commitizen prompt
 *     against /dev/tty. The commit blocked forever. Note that `--no-verify`
 *     does NOT cover `prepare-commit-msg`, which is why the fix disables
 *     `core.hooksPath` instead.
 *
 * Both are reproduced against real git, not mocked, because both bugs were in
 * the exact bytes git emits and consumes.
 *
 * Run: npx tsx server/src/scripts/checkGitSafety.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitWithSubmodules, getDiffWithSubmodules } from "../skills/submoduleGit.js";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A scratch repo with an identity, so commits work without touching user config. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-git-safety-"));
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "user.email", "check@example.invalid"]);
  git(dir, ["config", "user.name", "Git Safety Check"]);
  return dir;
}

/**
 * The exact shape that triggered bug 1, and it is fussier than it looks.
 *
 * The file must END ON A BLANK LINE, and the edit must be close enough to the
 * end that the blank line falls inside the hunk's trailing context. The diff
 * then finishes with a context line that is a single space — and `.trim()`
 * erases it, leaving the hunk one line shorter than its header declares.
 *
 * Two details are load-bearing:
 *  - The MODIFIED file must sort last (`z.res` after `b.res`), because only the
 *    final hunk of the combined diff is exposed to a trailing trim.
 *  - It must be a modification, not a new file. A new file's last line is `+…`,
 *    and git tolerates a missing newline after an added line — so an added-file
 *    fixture passes even with the bug present and proves nothing.
 *
 * Note the DOUBLE trailing "": one supplies the file's terminating newline, the
 * second is the blank final line itself. With only one, the file ends "}\n" and
 * git emits no space-only context line at all — the fixture then passes even
 * with the bug present.
 *
 * This mirrors port-web-pr-1412, whose final hunk declared new=9 and carried 8.
 */
const BASE_FILE = ["let x = {", "  a: 1,", "}", "", ""].join("\n");
const EDITED_FILE = ["let x = {", "  a: 1,", "  b: 2,", "}", "", ""].join("\n");

async function testPatchRoundTrips(): Promise<void> {
  console.log("\nBug 1 — diff must round-trip through `git apply`");
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "z.res"), BASE_FILE);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);

    // Edit an existing file AND add an untracked one: the combined-diff path is
    // where the join bug lived, so exercise more than a single hunk. `z.res`
    // sorts after `b.res`, so the vulnerable hunk lands at the very end.
    fs.writeFileSync(path.join(dir, "z.res"), EDITED_FILE);
    fs.writeFileSync(path.join(dir, "b.res"), ["let n = 0", ""].join("\n"));

    const { diff, fileCount } = await getDiffWithSubmodules(dir, "web");
    check("diff is non-empty", diff.length > 0);
    check("both files reported", fileCount === 2, `fileCount=${fileCount}`);
    check("diff ends with a newline", diff.endsWith("\n"),
      `last 20 chars: ${JSON.stringify(diff.slice(-20))}`);

    // The real assertion: git itself must accept it. This is what failed before.
    const patchFile = path.join(dir, "candidate.patch");
    fs.writeFileSync(patchFile, diff);
    let applyError = "";
    try {
      git(dir, ["apply", "--check", "--reverse", patchFile]);
    } catch (err) {
      applyError = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message);
    }
    check("git apply --check --reverse accepts the patch", applyError === "", applyError.trim());

    // Every hunk's declared line counts must match its body, which is the
    // invariant trimming violated.
    check("hunk headers agree with hunk bodies", hunkCountsAgree(diff),
      "a hunk declares more lines than its body contains");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Verify each `@@ -a,b +c,d @@` header against the lines that follow it.
 *
 * The single terminating newline is removed BEFORE splitting. Leaving it in
 * yields a phantom final "" element, and counting that as a context line is
 * exactly what masks a hunk that is one line short — i.e. it would hide the
 * defect this function exists to detect.
 */
function hunkCountsAgree(diff: string): boolean {
  const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  const lines = body.split("\n");
  let declaredOld = 0, declaredNew = 0, oldSeen = 0, newSeen = 0, inHunk = false;

  const settled = (): boolean => !inHunk || (oldSeen === declaredOld && newSeen === declaredNew);

  for (const line of lines) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      if (!settled()) return false;
      declaredOld = header[1] === undefined ? 1 : Number(header[1]);
      declaredNew = header[2] === undefined ? 1 : Number(header[2]);
      oldSeen = 0; newSeen = 0; inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git")) {
      if (!settled()) return false;
      inHunk = false;
      continue;
    }
    if (line.startsWith("\\")) continue;              // "\ No newline at end of file"
    if (line.startsWith("-")) { oldSeen++; continue; }
    if (line.startsWith("+")) { newSeen++; continue; }
    if (line.startsWith(" ")) { oldSeen++; newSeen++; continue; }
    // git writes " " for a blank context line, never "". Now that the trailing
    // newline is stripped, a bare "" inside a hunk body is malformed input —
    // count it so the totals still reconcile, but never treat it as free space.
    if (line === "") { oldSeen++; newSeen++; }
  }
  return settled();
}

async function testHookCannotHang(): Promise<void> {
  console.log("\nBug 2 — an interactive hook must not block a commit");
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.res"), BASE_FILE);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);

    // Reproduce the client-core hook: read from the terminal and block. `sleep`
    // stands in for commitizen's prompt — the failure mode is identical, and it
    // terminates on its own if the guard ever regresses, so the check reports a
    // failure rather than hanging CI.
    const hooks = path.join(dir, ".acchooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "prepare-commit-msg");
    fs.writeFileSync(hook, "#!/bin/sh\nexec < /dev/tty\nsleep 30\n");
    fs.chmodSync(hook, 0o755);
    git(dir, ["config", "core.hooksPath", ".acchooks"]);

    fs.writeFileSync(path.join(dir, "a.res"), EDITED_FILE);

    const startedAt = Date.now();
    let commitError = "";
    try {
      await commitWithSubmodules(dir, "web", "test: hook must be bypassed");
    } catch (err) {
      commitError = (err as Error).message;
    }
    const elapsedMs = Date.now() - startedAt;

    check("commit did not block on the hook", elapsedMs < 15_000, `took ${elapsedMs}ms`);
    check("commit reported no error", commitError === "", commitError);

    const log = git(dir, ["log", "--oneline"]).trim().split("\n");
    check("a new commit actually landed", log.length === 2, `log has ${log.length} entries`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("git safety checks");
  await testPatchRoundTrips();
  await testHookCannotHang();
  console.log(failures === 0 ? "\nAll git safety checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
