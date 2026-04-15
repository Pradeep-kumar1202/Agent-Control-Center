/**
 * Frontend skills registry — maps skill IDs to their form and results
 * components. App.tsx renders tabs and content dynamically from this list.
 * New skills are registered here; no changes needed in App.tsx.
 */

import type { ComponentType } from "react";
import { PropsForm } from "./props/Form";
import { PropsResults } from "./props/Results";
import { TestsForm } from "./tests/Form";
import { TestsResults } from "./tests/Results";
import { TranslationsForm } from "./translations/Form";
import { TranslationsResults } from "./translations/Results";
import { ReviewForm } from "./review/Form";
import { ReviewResults } from "./review/Results";
import { IntegrationForm } from "./integration/Form";
import { IntegrationResults } from "./integration/Results";
import { SdkIntegratorForm } from "./sdk-integrator/Form";
import { SdkIntegratorResults } from "./sdk-integrator/Results";
import { CoderForm } from "./coder/Form";
import { CoderResults } from "./coder/Results";

// ─── Shared types ────────────────────────────────────────────────────────────

export interface SkillRepoResultClient {
  repo: string;
  branch: string;
  diff: string;
  filesTouched: number;
  summary: string;
  error?: string;
  prUrl?: string | null;
  prNumber?: number | null;
  prWarning?: string | null;
}

export interface SkillEnvelopeClient {
  skillId: string;
  status: "ok" | "partial" | "error";
  results: Record<string, SkillRepoResultClient>;
  meta?: Record<string, unknown>;
}

export interface SkillFormProps {
  onResult: (result: SkillEnvelopeClient) => void;
  onError: (msg: string) => void;
}

export interface SkillResultsProps {
  result: SkillEnvelopeClient;
  onClose: () => void;
}

// ─── Skill config ─────────────────────────────────────────────────────────────

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  /** Tailwind classes for the active tab state. */
  activeTabClass: string;
  FormComponent: ComponentType<SkillFormProps>;
  ResultsComponent: ComponentType<SkillResultsProps>;
}

export const SKILLS_REGISTRY: SkillConfig[] = [
  {
    id: "props",
    name: "Add Prop",
    description: "Add a configuration prop across both SDKs",
    activeTabClass: "border-amber-500 text-amber-300",
    FormComponent: PropsForm,
    ResultsComponent: PropsResults,
  },
  {
    id: "tests",
    name: "Test Writer",
    description: "Write Cypress + Detox tests for a feature branch",
    activeTabClass: "border-emerald-500 text-emerald-300",
    FormComponent: TestsForm,
    ResultsComponent: TestsResults,
  },
  {
    id: "translations",
    name: "Translator",
    description: "Translate a key into all 32 languages",
    activeTabClass: "border-sky-500 text-sky-300",
    FormComponent: TranslationsForm,
    ResultsComponent: TranslationsResults,
  },
  {
    id: "review",
    name: "PR Review",
    description: "Opus-powered comprehensive PR review",
    activeTabClass: "border-violet-500 text-violet-300",
    FormComponent: ReviewForm,
    ResultsComponent: ReviewResults,
  },
  {
    id: "integration",
    name: "Integration Agent",
    description: "Implement a payment method from external docs",
    activeTabClass: "border-rose-500 text-rose-300",
    FormComponent: IntegrationForm,
    ResultsComponent: IntegrationResults,
  },
  {
    id: "sdk-integrator",
    name: "SDK Integrator",
    description: "Implement a native SDK integration from vendor docs",
    activeTabClass: "border-orange-500 text-orange-300",
    FormComponent: SdkIntegratorForm,
    ResultsComponent: SdkIntegratorResults,
  },
  {
    id: "coder",
    name: "Coder",
    description: "General-purpose coding: bug fixes, refactors, features",
    activeTabClass: "border-indigo-500 text-indigo-300",
    FormComponent: CoderForm,
    ResultsComponent: CoderResults,
  },
];
