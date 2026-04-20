/**
 * Global Preview Panel state.
 *
 * The panel is a single right-side drawer that any skill (Gap Analysis,
 * Add Prop, Test Writer, future ones) can open to watch the emulator,
 * edit the mock-server paymentIntent body, or control the merchant server.
 *
 * Usage:
 *   const { open } = usePreviewPanel();
 *   open({ repoKey: "mobile", branch: "main", initialTab: "emulator" });
 *
 * All fields on the open() context are optional — calling open() with no
 * args just surfaces the panel in whatever state the user last left it,
 * which is the intended behavior for the top-bar toggle button.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type PreviewPanelTab = "emulator" | "config" | "server";

export interface PreviewPanelContext {
  repoKey: "web" | "mobile";
  branch: string;
  initialTab?: PreviewPanelTab;
  patchId?: number | null;
  prUrl?: string | null;
  prWarning?: string | null;
  gapName?: string;
}

export interface PreviewPanelState {
  open: boolean;
  ctx: PreviewPanelContext;
}

interface PreviewPanelApi {
  state: PreviewPanelState;
  open: (ctx?: Partial<PreviewPanelContext>) => void;
  close: () => void;
  setCtx: (updates: Partial<PreviewPanelContext>) => void;
}

const DEFAULT_CTX: PreviewPanelContext = {
  repoKey: "mobile",
  branch: "main",
  initialTab: "emulator",
};

const Ctx = createContext<PreviewPanelApi | null>(null);

export function PreviewPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PreviewPanelState>({
    open: false,
    ctx: DEFAULT_CTX,
  });

  const open = useCallback((updates?: Partial<PreviewPanelContext>) => {
    setState((prev) => ({
      open: true,
      ctx: { ...prev.ctx, ...(updates ?? {}) },
    }));
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const setCtx = useCallback((updates: Partial<PreviewPanelContext>) => {
    setState((prev) => ({ ...prev, ctx: { ...prev.ctx, ...updates } }));
  }, []);

  const api = useMemo<PreviewPanelApi>(() => ({ state, open, close, setCtx }), [state, open, close, setCtx]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePreviewPanel(): PreviewPanelApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("usePreviewPanel must be used inside <PreviewPanelProvider>");
  return api;
}
