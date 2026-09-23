/**
 * Fail fast, and in plain language, when the environment cannot run the server.
 *
 * The failure this exists to prevent looked like a dashboard outage rather than
 * a setup problem. Starting under the wrong Node produced:
 *
 *   Error: The module '.../better_sqlite3.node' was compiled against a
 *   different Node.js version using NODE_MODULE_VERSION 127. This version of
 *   Node.js requires NODE_MODULE_VERSION 147.
 *
 * followed by hundreds of lines of `[vite] http proxy error: ECONNREFUSED`,
 * because the server had exited and the web proxy kept retrying. The actual
 * cause — `/opt/homebrew/bin/node` is v26, the project needs v22 — was nowhere
 * in that output.
 *
 * Deliberately dependency-free and plain .mjs: it has to run correctly on the
 * WRONG Node version, which is the only situation it matters in.
 *
 * Run automatically by `npm run dev`; also runnable directly via
 * `node scripts/preflight.mjs`.
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function fail(title, lines) {
  console.error(`\n${RED}${BOLD}✖ ${title}${RESET}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

/** Single source of truth for the required major version. */
function requiredMajor() {
  const raw = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
  const major = Number.parseInt(raw.replace(/^v/, ""), 10);
  if (!Number.isInteger(major)) fail("`.nvmrc` is unreadable", [`Found: ${JSON.stringify(raw)}`]);
  return major;
}

/** Version of the node at `execPath`, or null if it cannot be run. */
function versionOf(execPath) {
  try {
    return execFileSync(execPath, ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Distinguish "you are on the wrong Node" from "npm is forcing the wrong Node".
 *
 * npm runs every script with the interpreter that launched npm itself, and
 * prepends that interpreter's directory to the script's PATH. So an npm binary
 * belonging to a different Node install silently overrides `nvm use`: the shell
 * has v22, `node -v` says v22, and the script still gets v26. Telling that user
 * to "run nvm use 22" is useless — they already did, and the message reads like
 * the tool is broken.
 *
 * `npm_node_execpath` is set by npm to exactly that interpreter, which makes the
 * two cases separable.
 */
function diagnoseInterpreter(wanted) {
  const lines = [];
  const npmNode = process.env.npm_node_execpath;
  const npmCli = process.env.npm_execpath;
  const viaNpm = Boolean(npmNode) && npmNode !== process.execPath;

  lines.push(`Interpreter running this script: ${process.execPath}`);
  if (npmCli) lines.push(`npm in use: ${npmCli}`);
  if (viaNpm) lines.push(`npm's Node: ${npmNode} (${versionOf(npmNode) ?? "unreadable"})`);

  // Is a correct Node installed but simply not the one npm picked?
  const home = process.env.HOME ?? process.env.USERPROFILE;
  let nvmCandidate = null;
  if (home) {
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    try {
      const match = fs.readdirSync(nvmDir)
        .filter((name) => name.startsWith(`v${wanted}.`))
        .sort()
        .pop();
      if (match) nvmCandidate = path.join(nvmDir, match, "bin");
    } catch { /* nvm not installed */ }
  }

  if (nvmCandidate) {
    lines.push("", `${BOLD}A suitable Node IS installed:${RESET} ${nvmCandidate}`);
    lines.push(
      "",
      `${YELLOW}If you already ran \`nvm use ${wanted}\`, this is the cause:${RESET}`,
      "npm runs scripts with the Node that launched npm — NOT the `node` on your",
      "PATH. An npm from another install (e.g. Homebrew) therefore overrides nvm.",
      "",
      `${BOLD}Check which npm you are actually using:${RESET}`,
      "  which npm        # should be under ~/.nvm/versions/node/...",
      "",
      `${BOLD}If it is not, put nvm first for this shell:${RESET}`,
      `  export PATH="${nvmCandidate}:$PATH"`,
      "  hash -r",
      "",
      "Then re-run. To make it permanent, ensure nvm's init line comes AFTER any",
      'Homebrew PATH export in your ~/.zshrc, or run `brew unlink node`.',
    );
  } else {
    lines.push(
      "",
      `${BOLD}Fix (in this same terminal, then re-run):${RESET}`,
      `  nvm use ${wanted}`,
      "",
      "If that version is not installed yet:",
      `  nvm install ${wanted}`,
    );
  }
  return lines;
}

function checkNodeVersion(wanted) {
  const actual = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (actual === wanted) return;

  const hints = [
    `This project requires Node ${wanted}.x — this script is running v${process.versions.node}.`,
    "",
    ...diagnoseInterpreter(wanted),
  ];

  if (actual > wanted) {
    hints.push(
      "",
      `${YELLOW}Why it is pinned:${RESET} better-sqlite3 ships no prebuilt binary for`,
      `Node ${actual}, and building it from source fails on this platform.`,
    );
  }
  fail(`Wrong Node.js version`, hints);
}

/**
 * Load the native module for real rather than comparing ABI numbers.
 *
 * A version match is not sufficient: the binary can also be missing, or built
 * for a different architecture after an OS migration. Only an actual load
 * distinguishes those, and it is the same operation the server performs at
 * startup, so a pass here means the server will get past it too.
 */
function checkNativeModules() {
  try {
    require("better-sqlite3");
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const abi = message.match(/NODE_MODULE_VERSION (\d+)/g);
    fail("better-sqlite3 cannot be loaded", [
      abi
        ? `Native module ABI mismatch (${abi.join(" vs ")}).`
        : "The native module is missing or unreadable.",
      "",
      `${BOLD}Fix:${RESET}`,
      "  npm rebuild better-sqlite3",
      "",
      "If that fails, remove and reinstall:",
      "  rm -rf node_modules && npm install",
      "",
      `Original error: ${message.split("\n")[0]}`,
    ]);
  }
}

/**
 * A stale server holding port 5174 is the other way the dashboard appears
 * broken: the new server exits with EADDRINUSE, and the browser keeps talking
 * to the old process running old code. Warn rather than fail — the port may
 * legitimately be held by a server the developer wants to keep.
 */
function warnIfPortBusy(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return;
    const pids = [...new Set(out.split("\n").slice(1).map((l) => l.split(/\s+/)[1]))];
    console.error(
      `\n${YELLOW}${BOLD}! Port ${port} is already in use${RESET} (pid ${pids.join(", ")})`,
    );
    console.error(`  The new server will fail to bind. Stop it with:  kill ${pids.join(" ")}\n`);
  } catch {
    /* lsof missing or nothing listening — nothing to report */
  }
}

const wanted = requiredMajor();
checkNodeVersion(wanted);
checkNativeModules();
warnIfPortBusy(Number(process.env.PORT ?? 5174));
console.log(`✔ preflight: Node v${process.versions.node}, native modules OK`);
