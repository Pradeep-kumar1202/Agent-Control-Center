/**
 * Deterministic gap derivation for config, backend_api and component.
 *
 *   parse both SDKs' declarations  →  apply the checked-in equivalence table
 *   →  every declared key with no counterpart (by name, alias, or re-checked
 *      implicit evidence) is a gap, identified by its declared key.
 *
 * Zero model calls. Same inputs, same output. A parser that cannot find its
 * anchor throws SurfaceParseError, which fails the whole analysis run rather
 * than producing a one-sided flood of false gaps.
 */

import { extractBackendApiSurface } from "./backendApi.js";
import { extractComponentSurface } from "./components.js";
import { extractConfigSurface } from "./config.js";
import {
  compareKey,
  EQUIVALENCES,
  IMPLICIT_PRESENCE,
  implicitPresenceHolds,
  NOT_SURFACE,
  PLATFORM_SCOPED,
} from "./equivalences.js";
import type { Side, SurfaceCategory, SurfaceItem } from "./types.js";

export { SurfaceParseError } from "./source.js";
export type { Side, SurfaceCategory, SurfaceItem } from "./types.js";

export const SURFACE_CATEGORIES: SurfaceCategory[] = ["config", "backend_api", "component"];

const EXTRACT: Record<SurfaceCategory, (side: Side, repoDir: string) => SurfaceItem[]> = {
  config: extractConfigSurface,
  backend_api: extractBackendApiSurface,
  component: extractComponentSurface,
};

/** Where each category was read from — quoted in gap rationales so a reader knows what "absent" was checked against. */
const SEARCHED: Record<SurfaceCategory, Record<Side, string>> = {
  config: {
    web: "PaymentType.res itemToObjMapper/allowedPaymentElementOptions and CardTheme.res elements options",
    mobile: "SdkTypes.res parseConfigurationDict and LayoutTypes.res parseLayout",
  },
  backend_api: {
    web: "APIUtils.res endpoint registry and every `${…url/endpoint}/path` literal under src/ and shared-code/",
    mobile: "every `${…url/endpoint}/path` literal under src/ and shared-code/",
  },
  component: {
    web: "CardThemeType.res getPaymentMode entry points and the feature catalogue",
    mobile: "SdkTypes.res parseSdkState/parsePmmState entry points and the feature catalogue",
  },
};

export interface SurfaceGap {
  category: SurfaceCategory;
  /** Key as declared on the present side. */
  key: string;
  /** Stable, human-readable identity used as gaps.canonical_name. */
  canonicalName: string;
  missingIn: Side;
  presentIn: Side;
  evidence: SurfaceItem;
  platformSpecific: boolean;
  rationale: string;
}

export interface SurfaceDiff {
  category: SurfaceCategory;
  surface: Record<Side, SurfaceItem[]>;
  gaps: SurfaceGap[];
  /** Declared keys that have a counterpart on the other side. */
  matched: number;
  excluded: Array<{ side: Side; key: string; reason: string }>;
  /** Equivalence-table rows that no longer match the code. Never fatal; always surfaced. */
  tableWarnings: string[];
}

export function analyzeSurfaces(repoDirs: Record<Side, string>): SurfaceDiff[] {
  return SURFACE_CATEGORIES.map((category) =>
    diffSurface(category, {
      web: EXTRACT[category]("web", repoDirs.web),
      mobile: EXTRACT[category]("mobile", repoDirs.mobile),
    }, repoDirs),
  );
}

export function diffSurface(
  category: SurfaceCategory,
  raw: Record<Side, SurfaceItem[]>,
  repoDirs: Record<Side, string>,
): SurfaceDiff {
  const excluded: SurfaceDiff["excluded"] = [];
  const tableWarnings: string[] = [];

  const surface: Record<Side, SurfaceItem[]> = { web: [], mobile: [] };
  for (const side of ["web", "mobile"] as const) {
    for (const item of raw[side]) {
      const rule = NOT_SURFACE.find((r) => r.category === category && r.side === side && r.key === item.key);
      if (rule) excluded.push({ side, key: item.key, reason: rule.reason });
      else surface[side].push(item);
    }
  }

  const keys: Record<Side, Set<string>> = {
    web: new Set(surface.web.map((i) => compareKey(category, i.key))),
    mobile: new Set(surface.mobile.map((i) => compareKey(category, i.key))),
  };
  const has = (side: Side, key: string) => keys[side].has(compareKey(category, key));

  const partners = (side: Side, key: string): string[] =>
    EQUIVALENCES.filter((e) => e.category === category && compareKey(category, e[side]) === compareKey(category, key))
      .map((e) => (side === "web" ? e.mobile : e.web));

  const implicitOn = (side: Side, key: string): boolean => {
    const rule = IMPLICIT_PRESENCE.find((r) => r.category === category && r.side === side && r.key === key);
    return !!rule && implicitPresenceHolds(rule, repoDirs[side]);
  };

  const gaps: SurfaceGap[] = [];
  let matched = 0;
  for (const presentIn of ["web", "mobile"] as const) {
    const missingIn: Side = presentIn === "web" ? "mobile" : "web";
    for (const item of surface[presentIn]) {
      const present =
        has(missingIn, item.key) ||
        partners(presentIn, item.key).some((p) => has(missingIn, p)) ||
        implicitOn(missingIn, item.key);
      if (present) {
        matched++;
        continue;
      }
      const scoped = PLATFORM_SCOPED.find(
        (r) => r.category === category && r.side === presentIn && r.key === item.key,
      );
      gaps.push({
        category,
        key: item.key,
        canonicalName: canonicalName(category, item.key),
        missingIn,
        presentIn,
        evidence: item,
        platformSpecific: !!scoped,
        rationale: scoped
          ? `Platform-specific: ${scoped.reason}`
          : `Declared in ${presentIn} at ${item.file}:${item.line}. No \`${item.key}\` or known alias found in ${missingIn} (searched ${SEARCHED[category][missingIn]}).`,
      });
    }
  }

  // Table hygiene: every row must still describe the code.
  for (const e of EQUIVALENCES.filter((e) => e.category === category)) {
    for (const side of ["web", "mobile"] as const) {
      if (!has(side, e[side])) tableWarnings.push(`equivalence ${e.web} ↔ ${e.mobile}: \`${e[side]}\` no longer declared in ${side}`);
    }
  }
  for (const r of PLATFORM_SCOPED.filter((r) => r.category === category)) {
    if (!has(r.side, r.key)) tableWarnings.push(`platform-scoped \`${r.key}\` no longer declared in ${r.side}`);
    else if (has(r.side === "web" ? "mobile" : "web", r.key)) {
      tableWarnings.push(`platform-scoped \`${r.key}\` now exists on both sides — remove the row`);
    }
  }
  for (const r of NOT_SURFACE.filter((r) => r.category === category)) {
    if (!raw[r.side].some((i) => i.key === r.key)) tableWarnings.push(`not-surface \`${r.key}\` no longer declared in ${r.side}`);
  }
  for (const r of IMPLICIT_PRESENCE.filter((r) => r.category === category)) {
    if (!implicitPresenceHolds(r, repoDirs[r.side])) {
      tableWarnings.push(`implicit presence of \`${r.key}\` in ${r.side}: evidence \`${r.evidence.contains}\` not found in ${r.evidence.file}`);
    }
  }

  return { category, surface, gaps, matched, excluded, tableWarnings };
}

/** `paymentMethodOrder` → `payment_method_order`; `netceteraSDKApiKey` → `netcetera_sdk_api_key`; API paths unchanged. */
export function canonicalName(category: SurfaceCategory, key: string): string {
  if (category === "backend_api") return key;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}
