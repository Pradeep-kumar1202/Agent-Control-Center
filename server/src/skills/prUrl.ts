import type { RepoKey } from "../config.js";
import { forkSlug, upstreamSlug } from "./githubPr.js";

export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
  /** Canonical URL with query strings, fragments and sub-pages removed. */
  url: string;
}

export interface PortDirection {
  pr: ParsedPr;
  source: RepoKey;
  target: RepoKey;
}

export class PrUrlError extends Error {
  readonly code = "INVALID_PR_URL" as const;

  constructor(message: string) {
    super(message);
    this.name = "PrUrlError";
  }
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

function normalizeRepo(repo: string): string {
  return repo.replace(/\.git$/i, "").toLowerCase();
}

function splitSlug(slug: string): [owner: string, repo: string] {
  const slash = slug.indexOf("/");
  return [slug.slice(0, slash), slug.slice(slash + 1)];
}

/** Parse a GitHub PR URL without making a network call. */
export function parsePrUrl(raw: string): ParsedPr | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (host !== "github.com" && host !== "www.github.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) return null;

  const owner = parts[0];
  const repo = normalizeRepo(parts[1]);
  const number = Number(parts[3]);
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo) || !Number.isSafeInteger(number) || number < 1) {
    return null;
  }

  return {
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

/** Map both upstream repos and the configured dashboard forks to one workspace repo. */
export function repoKeyForSlug(owner: string, repo: string): RepoKey | null {
  const wanted = `${owner}/${normalizeRepo(repo)}`.toLowerCase();
  for (const key of ["web", "mobile"] as const) {
    if (wanted === upstreamSlug(key).toLowerCase()) return key;
    if (wanted === forkSlug(key).toLowerCase()) return key;
  }
  return null;
}

export function recognisedPrSlugs(): string[] {
  return [
    upstreamSlug("web"),
    upstreamSlug("mobile"),
    forkSlug("web"),
    forkSlug("mobile"),
  ];
}

/** Infer web -> mobile or mobile -> web solely from the URL's repository. */
export function resolvePortDirection(raw: string): PortDirection {
  const pr = parsePrUrl(raw);
  if (!pr) {
    throw new PrUrlError("Expected a GitHub pull-request URL such as https://github.com/juspay/hyperswitch-web/pull/123");
  }

  const source = repoKeyForSlug(pr.owner, pr.repo);
  if (!source) {
    throw new PrUrlError(
      `PR repository \"${pr.owner}/${pr.repo}\" is not recognised. Expected one of: ${recognisedPrSlugs().join(", ")}`,
    );
  }

  return { pr, source, target: source === "web" ? "mobile" : "web" };
}

/** Useful to callers that already have a slug string. */
export function repoKeyForFullSlug(slug: string): RepoKey | null {
  const [owner, repo] = splitSlug(slug);
  return owner && repo ? repoKeyForSlug(owner, repo) : null;
}
