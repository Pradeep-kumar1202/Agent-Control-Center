import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken page from taking down the dashboard.
 *
 * React 18 unmounts the entire root on an uncaught render error, so before this
 * existed a single bad field — a `notes` array missing from a cached API
 * response — turned the whole app, sidebar included, into a blank screen with
 * nothing on it to explain why or navigate away from.
 *
 * Reset it with a `resetKey` (the active tab): navigating elsewhere clears the
 * error, so a user is never stuck.
 */

interface Props {
  children: ReactNode;
  /** Change this to clear the error — pass the active tab. */
  resetKey?: string | number;
  label?: string;
}

interface State {
  error: Error | null;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, stack: undefined });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack — "which component" is the part the message omits.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="rounded-xl border border-red-800 bg-red-950/30 p-5 text-sm text-red-200">
        <div className="mb-1 font-semibold">
          {this.props.label ? `${this.props.label} failed to render` : "This page failed to render"}
        </div>
        <p className="mb-3 text-xs text-red-300/80">
          The rest of the dashboard is unaffected — pick another item in the sidebar to carry on.
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/70 p-3 font-mono text-xs text-red-300">
          {error.message}
          {stack ? `\n${stack.split("\n").slice(0, 6).join("\n")}` : ""}
        </pre>
        <button
          className="mt-3 rounded-md border border-red-700 px-3 py-1.5 text-xs text-red-200 hover:border-red-500"
          onClick={() => this.setState({ error: null, stack: undefined })}
        >
          Try again
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
