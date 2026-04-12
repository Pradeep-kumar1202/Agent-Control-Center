/**
 * Skills registry — the single source of truth for all LLM-powered skills
 * available in the dashboard. New skills must be registered here.
 */

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  repos: Array<"web" | "mobile" | "rn_packages">;
}

/** Uniform result shape returned by every skill for each repo it touches. */
export interface SkillRepoResult {
  repo: string;
  branch: string;
  diff: string;
  filesTouched: number;
  summary: string;
  error?: string;
}

/** Top-level envelope returned by every POST /skills/{id}/generate endpoint. */
export interface SkillEnvelope {
  skillId: string;
  status: "ok" | "partial" | "error";
  results: Record<string, SkillRepoResult>;
  /** Skill-specific extras (e.g. propName for props, ReviewResult for review). */
  meta?: Record<string, unknown>;
}

export const SKILLS: SkillManifest[] = [
  {
    id: "props",
    name: "Add Prop",
    description:
      "Add a configuration prop across both SDKs following each repo's existing patterns",
    endpoint: "/skills/props/generate",
    repos: ["web", "mobile"],
  },
  {
    id: "tests",
    name: "Test Writer",
    description:
      "Write Cypress (web) and Detox (mobile) tests for a feature branch",
    endpoint: "/skills/tests/generate",
    repos: ["web", "mobile"],
  },
  {
    id: "translations",
    name: "Translator",
    description:
      "Translate a new i18n key into all 32 languages and insert it surgically into locale files",
    endpoint: "/skills/translations/generate",
    repos: ["web", "mobile"],
  },
  {
    id: "review",
    name: "PR Reviewer",
    description:
      "Comprehensive Opus-powered review: correctness, patterns, tests, translations, security, edge cases",
    endpoint: "/skills/review/generate",
    repos: ["web", "mobile"],
  },
  {
    id: "integration",
    name: "SDK Integration",
    description:
      "Implement a native SDK integration across repos with automated review loop",
    endpoint: "/skills/integration/generate",
    repos: ["mobile", "rn_packages", "web"],
  },
];
