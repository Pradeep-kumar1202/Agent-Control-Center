/**
 * Agent-profile resolution for skill entry points.
 *
 * Two things every skill route must do BEFORE it starts a run, and which only
 * PR Port did:
 *
 *  1. Honour the browser's `X-Agent-Profiles` override.
 *  2. Resolve every slot the pipeline will use, and fail with a real HTTP
 *     status if that is impossible.
 *
 * Step 2 matters because the alternative is discovering an unassigned slot
 * twenty minutes into a run, or — worse — after response headers have been
 * flushed, at which point the only way to report it is an error event buried in
 * a stream the user may no longer be watching. Resolving up front turns
 * "mysterious failure" into 428/422 before any work starts.
 */

import type { Request, Response } from "express";
import {
  AgentsNotConfiguredError,
  UnsupportedRuntimeCapabilityError,
  resolveRun,
  type AccessPolicy,
  type AgentSlot,
  type ProfileSnapshot,
} from "../runtime/index.js";
import { validateAgentSettings, type AgentSettings } from "../runtime/settings.js";

/**
 * Decode the per-browser profile override.
 *
 * The header is base64 of URI-encoded JSON so arbitrary model names survive
 * header transport. Validation is not optional: an override that names a
 * nonexistent runtime must be rejected at the door rather than producing a
 * confusing resolve failure later.
 */
export function requestOverride(req: Request): AgentSettings | undefined {
  const encoded = req.get("X-Agent-Profiles");
  if (!encoded) return undefined;
  let parsed: AgentSettings;
  try {
    const uriEncoded = Buffer.from(encoded, "base64").toString("utf8");
    parsed = JSON.parse(decodeURIComponent(uriEncoded)) as AgentSettings;
  } catch {
    throw new Error("X-Agent-Profiles is not a valid browser agent profile override");
  }
  const validation = validateAgentSettings(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid browser agent profile override: ${validation.errors.join("; ")}`);
  }
  return parsed;
}

/**
 * Resolve slots or respond with the right status code.
 *
 * Returns `null` after having already sent a response — callers just return.
 *
 *   428 Precondition Required  no profile assigned; the user must visit Settings
 *   422 Unprocessable          assigned runtime cannot provide the required
 *                              access tier (e.g. codex/opencode cannot express
 *                              text-only); a different runtime is needed
 *   400 Bad Request            malformed override header
 */
export function preflightSlots(
  req: Request,
  res: Response,
  slots: AgentSlot[],
  access: Partial<Record<AgentSlot, AccessPolicy>>,
  readDirs?: Partial<Record<AgentSlot, boolean>>,
): ProfileSnapshot | null {
  try {
    const override = requestOverride(req);
    return resolveRun(slots, { override, access, readDirs });
  } catch (err) {
    if (err instanceof AgentsNotConfiguredError) {
      res.status(428).json({ code: "AGENTS_NOT_CONFIGURED", error: err.message });
      return null;
    }
    if (err instanceof UnsupportedRuntimeCapabilityError) {
      res.status(422).json({ code: "RUNTIME_CAPABILITY", error: err.message });
      return null;
    }
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}
