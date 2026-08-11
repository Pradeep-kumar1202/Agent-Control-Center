/**
 * Per-browser override of the server's agent settings.
 *
 * The dashboard is shared, so two people may want different runtimes at the
 * same time. The server keeps a global default; a browser can override it
 * locally and send its choice with each request.
 *
 * Nothing sensitive lives here. Each CLI keeps its own credentials on the box
 * (~/.claude, ~/.codex, ~/.opencode) — this only ever stores which runtime and
 * model name to ask for, which is why a per-user override does not violate the
 * "no per-user credentials" constraint.
 */

export interface Profile {
  runtime: "claude-code" | "codex" | "opencode";
  invocation: string;
  effort?: string;
}

export interface AgentSettings {
  profiles: Record<string, Profile>;
  assignments: Record<string, string>;
}

const KEY = "acc.agentProfiles";

export function loadLocalOverride(): AgentSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentSettings;
    if (!parsed?.profiles || !parsed?.assignments) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLocalOverride(settings: AgentSettings | null): void {
  try {
    if (settings === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private browsing / quota — the server default still applies */
  }
}

/**
 * Header carrying the local override, if any.
 *
 * Base64 because settings are JSON and header values must stay single-line
 * ASCII. `encodeURIComponent` first so non-ASCII model names survive `btoa`.
 */
export function overrideHeader(): Record<string, string> {
  const local = loadLocalOverride();
  if (!local) return {};
  try {
    return { "X-Agent-Profiles": btoa(encodeURIComponent(JSON.stringify(local))) };
  } catch {
    return {};
  }
}
