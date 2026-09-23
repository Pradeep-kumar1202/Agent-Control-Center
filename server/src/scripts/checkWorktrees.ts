/**
 * Deterministic checks for per-run PR-port worktrees (workspace/worktree.ts).
 *
 *   npm run check:worktrees -w server
 *
 * Builds throwaway git repos in a temp dir that stand in for GitHub: an
 * "upstream" SDK with a shared-code submodule and a `refs/pull/7/head` ref, and
 * a local clone whose `main` carries an unpushed commit and whose submodule has
 * drifted off its pin. No network, no models.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPortWorktrees,
  finishPortWorktrees,
  portBranchName,
  preserveTargetWork,
  recoverOrphanedWorktrees,
} from "../workspace/worktree.js";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failed++;
}
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// The fixture's "remotes" are local paths; git refuses file:// submodule clones
// by default (production uses https). Allow it for this process only.
process.env.GIT_ALLOW_PROTOCOL = "file:https";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-check-"));

// ── fixtures ──────────────────────────────────────────────────────────────
// shared-code upstream with two commits; the SDK pins the first.
const sharedUp = path.join(T, "shared-up");
fs.mkdirSync(sharedUp);
git(sharedUp, "init", "-q");
write(path.join(sharedUp, "Shared.res"), "let v = 1\n");
git(sharedUp, "add", "."); git(sharedUp, "commit", "-qm", "shared 1");
const sharedPinned = git(sharedUp, "rev-parse", "HEAD");
write(path.join(sharedUp, "Shared.res"), "let v = 2\n");
git(sharedUp, "commit", "-qam", "shared 2");

// SDK upstream: main + a PR head that adds a file.
const sdkUp = path.join(T, "sdk-up");
fs.mkdirSync(sdkUp);
git(sdkUp, "init", "-q");
write(path.join(sdkUp, "src/App.res"), "let app = 1\n");
write(path.join(sdkUp, ".gitignore"), "node_modules/\n"); // client-core's rule: directories only
git(sdkUp, "add", ".");
git(sdkUp, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sharedUp, "shared-code");
git(path.join(sdkUp, "shared-code"), "checkout", "-q", sharedPinned);
git(sdkUp, "add", "."); git(sdkUp, "commit", "-qm", "main 1");
const upstreamMain = git(sdkUp, "rev-parse", "HEAD");
git(sdkUp, "checkout", "-qb", "feature");
write(path.join(sdkUp, "src/NewFeature.res"), "let feature = true\n");
git(sdkUp, "add", "."); git(sdkUp, "commit", "-qm", "feature");
const prHead = git(sdkUp, "rev-parse", "HEAD");
git(sdkUp, "update-ref", "refs/pull/7/head", prHead);
git(sdkUp, "checkout", "-q", "main");

// Local clone (the "workspace"): unpushed commit on main, submodule drifted, deps installed.
const clone = path.join(T, "clone");
git(T, "clone", "-q", sdkUp, clone);
git(clone, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
write(path.join(clone, "src/Local.res"), "let unpushed = 1\n");
git(clone, "add", "."); git(clone, "commit", "-qm", "local only");
git(path.join(clone, "shared-code"), "checkout", "-q", "origin/main");
fs.mkdirSync(path.join(clone, "node_modules/.bin"), { recursive: true });
const cloneHeadBefore = git(clone, "rev-parse", "HEAD");
const cloneStatusBefore = git(clone, "status", "--porcelain");

const worktreesDir = path.join(T, "worktrees");
const branch = portBranchName("web", 7);

console.log("worktree checks");

// ── create ────────────────────────────────────────────────────────────────
const wt = await createPortWorktrees({
  runId: 1, source: "web", target: "mobile", prNumber: 7, branch,
  expectedHeadSha: prHead, clones: { source: clone, target: clone }, worktreesDir,
});
check("source worktree is at the PR head SHA", git(wt.source.dir, "rev-parse", "HEAD") === prHead);
check("files the PR adds exist in the source worktree", fs.existsSync(path.join(wt.source.dir, "src/NewFeature.res")));
check("target branches from origin/main, not local main", wt.target.baseSha === upstreamMain && git(wt.target.dir, "rev-parse", "HEAD") === upstreamMain);
check("unpushed local commits do not leak into the target", !fs.existsSync(path.join(wt.target.dir, "src/Local.res")));
check("target is on the deterministic port branch", git(wt.target.dir, "rev-parse", "--abbrev-ref", "HEAD") === branch && branch === "port/pr-7-web");
check(
  "shared-code is initialised at the recorded pin, not the clone's drifted checkout",
  git(path.join(wt.target.dir, "shared-code"), "rev-parse", "HEAD") === sharedPinned,
);
check("node_modules is linked from the clone", fs.lstatSync(path.join(wt.target.dir, "node_modules")).isSymbolicLink());
check(
  "the shared clone is untouched (HEAD and working tree)",
  git(clone, "rev-parse", "HEAD") === cloneHeadBefore && git(clone, "status", "--porcelain") === cloneStatusBefore,
);

// ── preserve + finish ─────────────────────────────────────────────────────
write(path.join(wt.target.dir, "src/Ported.res"), "let ported = true\n");
check("uncommitted work is committed by preserveTargetWork", await preserveTargetWork(wt, "wip: cancelled"));
check("node_modules symlink is not committed", !git(clone, "show", "--stat", branch).includes("node_modules"));
await finishPortWorktrees(wt, true, "port/pr-");
check("worktree directories are removed", !fs.existsSync(wt.root));
check("the branch outlives its worktree, with the work on it", git(clone, "show", `${branch}:src/Ported.res`) === "let ported = true");
check("the clone has no stale worktree registrations", !git(clone, "worktree", "list").includes(wt.root));

// ── re-run: earlier attempt archived, never deleted ──────────────────────
const wt2 = await createPortWorktrees({
  runId: 2, source: "web", target: "mobile", prNumber: 7, branch,
  clones: { source: clone, target: clone }, worktreesDir,
});
check("a re-run archives the earlier branch instead of deleting it", wt2.archivedBranch === `${branch}-attempt-2-before`);
check("the archived branch keeps the earlier work", git(clone, "show", `${wt2.archivedBranch}:src/Ported.res`) === "let ported = true");
await finishPortWorktrees(wt2, false, "port/pr-");
check(
  "an empty re-run gives the earlier attempt its name back",
  git(clone, "branch", "--list", branch) !== "" && git(clone, "show", `${branch}:src/Ported.res`) === "let ported = true" &&
    git(clone, "branch", "--list", `${branch}-attempt-2-before`) === "",
);

// ── head moved between diff and checkout ─────────────────────────────────
let movedError = "";
try {
  await createPortWorktrees({
    runId: 3, source: "web", target: "mobile", prNumber: 7, branch: "port/pr-7-moved",
    expectedHeadSha: upstreamMain, clones: { source: clone, target: clone }, worktreesDir,
  });
} catch (err) { movedError = (err as Error).message; }
check("a PR head that moved since the diff aborts the start", movedError.includes("head moved"), movedError);
check("an aborted start leaves no run directory behind", !fs.existsSync(path.join(worktreesDir, "run-3")));

// ── crash recovery ────────────────────────────────────────────────────────
const wt4 = await createPortWorktrees({
  runId: 4, source: "web", target: "mobile", prNumber: 7, branch: "port/pr-7-crash",
  clones: { source: clone, target: clone }, worktreesDir,
});
write(path.join(wt4.target.dir, "src/HalfDone.res"), "let half = 1\n");
const recovered = await recoverOrphanedWorktrees(() => false, worktreesDir);
check("an orphaned run's uncommitted work is committed on boot", git(clone, "show", "port/pr-7-crash:src/HalfDone.res") === "let half = 1", recovered.join(","));
check("the orphaned worktree is removed after recovery", !fs.existsSync(wt4.root));
check("a live run is never touched by recovery", await (async () => {
  const wt5 = await createPortWorktrees({ runId: 5, source: "web", target: "mobile", prNumber: 7, branch: "port/pr-7-live", clones: { source: clone, target: clone }, worktreesDir });
  await recoverOrphanedWorktrees((id) => id === "5", worktreesDir);
  const kept = fs.existsSync(wt5.target.dir);
  await finishPortWorktrees(wt5, false, "port/pr-");
  return kept;
})());

fs.rmSync(T, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} worktree check(s) failed.`);
  process.exit(1);
}
console.log("All worktree checks passed.");
