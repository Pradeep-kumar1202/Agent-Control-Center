/**
 * One place where every server-side git invocation is configured.
 *
 * This exists because of two production hangs, both of which presented as "the
 * dashboard is stuck" with no error anywhere:
 *
 *  1. INTERACTIVE HOOKS. `hyperswitch-client-core` ships
 *     `.husky/prepare-commit-msg`, which runs:
 *         exec < /dev/tty && node_modules/.bin/git-cz --hook
 *     The dashboard is started from a terminal, so `/dev/tty` resolves to the
 *     operator's real terminal. Commitizen then opens an interactive prompt on a
 *     terminal nobody is watching — the browser user sees a phase that never
 *     advances — and the commit blocks forever.
 *
 *     `--no-verify` does NOT fix this. It bypasses `pre-commit` and `commit-msg`
 *     only; `prepare-commit-msg` still runs. Disabling `core.hooksPath` is the
 *     only reliable answer. (Measured: with the override the hook is skipped and
 *     the commit succeeds; without it the same commit blocks.)
 *
 *  2. CREDENTIAL AND EDITOR PROMPTS. Any git operation that decides it wants a
 *     username, a passphrase, or an editor will otherwise wait on stdin that no
 *     one can answer. Failing fast is strictly better than hanging.
 *
 * ## Why hooks are disabled through the environment
 *
 * simple-git refuses `core.hooksPath` passed via its `config` option
 * ("Configuring core.hooksPath is not permitted without enabling
 * allowUnsafeHooksPath"). Git's own `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` protocol has the same effect as `-c`, outranks repo-local
 * config, and passes through simple-git untouched. `runtime/agentEnv.ts` already
 * uses this idiom, so it is the established pattern in this codebase.
 *
 * ## Why pushes deliberately keep their hooks
 *
 * This machine carries a global `core.hooksPath=/etc/git-guardian/hooks`, which
 * provides a **pre-push** secret scanner. That is an organisation-wide control
 * on a shared box and must keep running. The hang is entirely at commit time, so
 * `localGit()` disables hooks and `publishGit()` does not. Never route a push
 * through `localGit()`.
 */

import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";

/**
 * Maximum time a git command may produce NO output before it is killed.
 *
 * This is simple-git's `timeout.block`, i.e. silence, not total duration — a
 * long fetch that keeps printing progress is unaffected. It exists so that a
 * command waiting on a prompt dies instead of pinning a run forever. Generous on
 * purpose: the goal is to catch deadlocks, not to impose a deadline.
 */
const BLOCK_TIMEOUT_MS = 120_000;

/** Git configuration applied to local, non-publishing operations. */
const LOCAL_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // See the header: this is the fix for the prepare-commit-msg hang.
  ["core.hooksPath", "/dev/null"],
];

/**
 * Strip any inherited `GIT_CONFIG_*` variables.
 *
 * A caller (or a parent process) that already set these would otherwise have its
 * indices collide with ours, producing a config list git reads as truncated or
 * mixed. We always publish a complete, self-consistent set.
 */
function withoutInheritedGitConfig(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  return env;
}

/**
 * Make git non-interactive.
 *
 * Note what is deliberately NOT set: `GIT_CONFIG_GLOBAL`. The user's global
 * config carries `user.name` / `user.email`, and a commit without an identity
 * fails outright. We override single keys rather than discarding whole files.
 */
function nonInteractiveEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = withoutInheritedGitConfig(source);
  env.GIT_TERMINAL_PROMPT = "0";   // fail instead of asking for a username
  env.GIT_EDITOR = "true";         // never open an editor for a message
  env.GIT_SEQUENCE_EDITOR = "true";
  env.GIT_PAGER = "cat";           // a pager on a non-tty can stall
  return env;
}

function applyGitConfig(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<readonly [string, string]>,
): NodeJS.ProcessEnv {
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Git for local workspace operations: status, diff, add, commit, checkout,
 * branch, clean, fetch.
 *
 * Hooks are OFF and every prompt is refused, so these can never block a run.
 * This is the correct choice for everything the dashboard does to a repo on
 * disk. It is the WRONG choice for `git push` — use `publishGit()` there.
 */
export function localGit(dir?: string, opts: Partial<SimpleGitOptions> = {}): SimpleGit {
  // Environment goes through `.env()`, not the options object — simple-git has
  // no `env` option, and passing one is silently ignored rather than rejected.
  return simpleGit(dir ?? process.cwd(), {
    timeout: { block: BLOCK_TIMEOUT_MS },
    ...opts,
  }).env(applyGitConfig(nonInteractiveEnv(process.env), LOCAL_GIT_CONFIG));
}

/**
 * Git for publishing operations that must reach a remote.
 *
 * Hooks are intentionally left ENABLED so the machine's `pre-push` secret
 * scanner still runs — it is a real control, and this is a shared machine.
 * Prompts are still refused: a push that cannot authenticate should fail with a
 * message, not hang holding a run open.
 *
 * No block timeout is imposed. The pre-push scanner is an 8.9 MB binary that can
 * legitimately spend a long time silent on a large diff, and killing a push
 * mid-flight is worse than waiting.
 */
export function publishGit(dir?: string, opts: Partial<SimpleGitOptions> = {}): SimpleGit {
  return simpleGit(dir ?? process.cwd(), { ...opts })
    .env(nonInteractiveEnv(process.env));
}
