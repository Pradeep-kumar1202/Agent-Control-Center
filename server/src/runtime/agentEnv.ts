/**
 * Environment inherited by model/agent CLI subprocesses.
 *
 * Agent tools need provider authentication and local Git reads, but they never
 * need authority to publish. Keep model-provider variables intact while
 * removing GitHub publishing credentials and injecting Git configuration that
 * makes direct GitHub pushes/fetches fail. The server-side publisher runs
 * outside this environment and is the only path allowed to reach GitHub.
 */

import path from "node:path";

const BLOCKED_PUSH_URL = "disabled://agent-control-center/direct-agent-push-is-forbidden";

/**
 * Preserve the launching shell's precedence, then add common per-user CLI
 * locations. GUI apps and version-manager restarts often inherit a smaller
 * PATH than an interactive shell even though the runtimes are installed.
 */
export function runtimeCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  const home = source.HOME ?? source.USERPROFILE;
  const candidates = [
    ...(source.PATH ?? "").split(path.delimiter),
    source.PNPM_HOME,
    source.BUN_INSTALL ? path.join(source.BUN_INSTALL, "bin") : undefined,
    source.VOLTA_HOME ? path.join(source.VOLTA_HOME, "bin") : undefined,
    ...(home ? [
      path.join(home, ".local", "bin"),
      path.join(home, ".opencode", "bin"),
      path.join(home, ".claude", "local"),
      path.join(home, ".claude", "local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, "Library", "pnpm"),
    ] : []),
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  env.PATH = [...new Set(candidates)].join(path.delimiter);
  return env;
}

export function agentSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = runtimeCliEnv(source);

  for (const key of [
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "SSH_AUTH_SOCK",
  ]) {
    delete env[key];
  }

  // Do not inherit caller-supplied command-scoped Git configuration. Agent
  // subprocesses get one fixed, auditable policy instead.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }

  const gitConfig: Array<[string, string]> = [
    ["credential.helper", ""],
    ["push.default", "nothing"],
    ["remote.origin.pushurl", BLOCKED_PUSH_URL],
    ["url.https://127.0.0.1:1/agent-github-blocked/.insteadOf", "https://github.com/"],
    ["url.ssh://invalid@127.0.0.1:1/agent-github-blocked/.insteadOf", "git@github.com:"],
    ["url.ssh://invalid@127.0.0.1:1/agent-github-blocked-ssh/.insteadOf", "ssh://git@github.com/"],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.SSH_ASKPASS = "/usr/bin/false";
  env.GIT_SSH_COMMAND = "/usr/bin/false";
  // gh must not discover the user's authenticated hosts/keyring entry.
  env.GH_CONFIG_DIR = "/dev/null/agent-control-center-gh-disabled";

  return env;
}

export { BLOCKED_PUSH_URL };
