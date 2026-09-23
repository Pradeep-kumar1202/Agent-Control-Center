import type { Category } from "../types.js";

export type Side = "web" | "mobile";

/** One item of an SDK's public surface, with exact source evidence. */
export interface SurfaceItem {
  /** Stable identity as declared in code: a config key, an API path, an entry-point string. */
  key: string;
  file: string;
  line: number;
  /** The declaring source line. */
  snippet: string;
}

export type SurfaceCategory = Category;
