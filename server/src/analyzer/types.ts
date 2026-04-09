/** Shared shape every extractor returns. */
export interface ExtractedFeature {
  /** Raw or canonicalized feature name. */
  name: string;
  /** Repo-relative path to the evidence file. */
  file: string;
  /** Short quote, signature, or filename — the smoking gun. */
  snippet: string;
}

export type Category =
  | "payment_method"
  | "config"
  | "component"
  | "backend_api";
