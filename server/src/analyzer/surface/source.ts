/**
 * Minimal, dependency-free readers for ReScript declaration files.
 *
 * The public surface of both SDKs is declared in a handful of decoder
 * functions (see config.ts, backendApi.ts, components.ts). These helpers
 * locate those functions and pull out the string-literal keys they read.
 *
 * Everything here FAILS LOUDLY. A decoder that moved or was renamed must
 * stop the analysis with a message naming the file and anchor — never
 * degrade to "found nothing", because an empty side turns every feature on
 * the other side into a false gap (LEARNINGS, 2026-09-23 audit).
 */

import fs from "node:fs";
import path from "node:path";

export class SurfaceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceParseError";
  }
}

export interface SourceFile {
  /** Repo-relative path, forward slashes. */
  rel: string;
  text: string;
}

export function readSource(repoDir: string, rel: string): SourceFile {
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) {
    throw new SurfaceParseError(`declaration file not found: ${rel} (in ${repoDir})`);
  }
  return { rel, text: fs.readFileSync(abs, "utf8") };
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The trimmed source line at a character offset — used as evidence. */
export function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end < 0 ? text.length : end).trim();
}

export interface Span {
  text: string;
  /** Offset of `text` within the file. */
  offset: number;
}

/**
 * Body of a top-level `let <name> = …` binding: from the binding up to the
 * next top-level `let`/`type`/`module`/`@` declaration. ReScript formats
 * top-level declarations at column 0, which makes this reliable without a
 * parser.
 */
export function topLevelLet(file: SourceFile, name: string): Span {
  const re = new RegExp(`^let ${escapeRe(name)}\\s*[=:]`, "m");
  const m = re.exec(file.text);
  if (!m) {
    throw new SurfaceParseError(`\`let ${name}\` not found in ${file.rel} — decoder moved or renamed`);
  }
  const rest = file.text.slice(m.index + m[0].length);
  const next = /^(let|type|module|@|open|include) /m.exec(rest);
  const end = next ? m.index + m[0].length + next.index : file.text.length;
  return { text: file.text.slice(m.index, end), offset: m.index };
}

export interface KeyHit {
  key: string;
  /** Offset within the file. */
  offset: number;
}

/**
 * String keys a decoder reads from a dict variable. Covers the idioms both
 * SDKs use:
 *   getBool(configObj, "key", …)       getX(dict, "key")
 *   configObj->Dict.get("key")         dict->getDictFromDict("key")
 * Arguments may span lines. First occurrence of each key wins.
 */
export function keysReadFrom(span: Span, dictVar: string): KeyHit[] {
  const v = escapeRe(dictVar);
  const patterns = [
    new RegExp(`\\(\\s*${v}\\s*,\\s*"([A-Za-z0-9_]+)"`, "g"),
    new RegExp(`\\b${v}\\s*->\\s*[A-Za-z0-9_.]+\\(\\s*"([A-Za-z0-9_]+)"`, "g"),
  ];
  const seen = new Map<string, number>();
  for (const re of patterns) {
    for (const m of span.text.matchAll(re)) {
      const off = span.offset + (m.index ?? 0);
      const prev = seen.get(m[1]);
      if (prev === undefined || off < prev) seen.set(m[1], off);
    }
  }
  return [...seen].map(([key, offset]) => ({ key, offset })).sort((a, b) => a.offset - b.offset);
}

/** Every string literal inside the first `[ … ]` array of a span. */
export function stringArrayLiterals(span: Span): KeyHit[] {
  const open = span.text.indexOf("[");
  const close = span.text.indexOf("]", open);
  if (open < 0 || close < 0) {
    throw new SurfaceParseError(`expected an array literal at offset ${span.offset}`);
  }
  const inner = span.text.slice(open, close);
  return [...inner.matchAll(/"([^"]+)"/g)].map((m) => ({
    key: m[1],
    offset: span.offset + open + (m.index ?? 0),
  }));
}

/** `| "literal" => Constructor` arms of a switch, in source order. */
export function switchStringArms(span: Span): Array<KeyHit & { target: string }> {
  return [...span.text.matchAll(/\|\s*"([^"]+)"\s*=>\s*([A-Za-z0-9_]+(?:\([A-Z0-9_]+\))?)/g)].map((m) => ({
    key: m[1],
    target: m[2],
    offset: span.offset + (m.index ?? 0),
  }));
}

/** Recursively list files under `dir` (repo-relative) with an extension. */
export function listFiles(repoDir: string, relDir: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(repoDir, rel);
    if (!fs.existsSync(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(childRel);
      else if (ent.name.endsWith(ext)) out.push(childRel);
    }
  };
  walk(relDir);
  return out.sort();
}

export function requireAtLeast<T>(items: T[], min: number, what: string): T[] {
  if (items.length < min) {
    throw new SurfaceParseError(
      `${what}: found ${items.length}, expected at least ${min} — the decoder changed shape; update the surface parser`,
    );
  }
  return items;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
