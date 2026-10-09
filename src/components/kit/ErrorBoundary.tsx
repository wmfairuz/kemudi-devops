import { Component, type ReactNode } from "react";

/** A screen that throws shows what broke instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-10 text-center text-foreground">
        <div className="text-[16px] font-semibold">Something in Kemudi Devops broke</div>
        <pre className="selectable max-w-[640px] overflow-auto rounded-lg border border-divider bg-panel p-3 text-left font-mono text-[12px] whitespace-pre-wrap text-env-prod-fg">
          {this.state.error.message}
        </pre>
        <div className="text-[12px] text-subtle-foreground">Reload reopens your tabs as fresh shells (nothing is re-run).</div>
        <button
          onClick={() => location.reload()}
          className="h-8 cursor-pointer rounded-lg bg-primary px-4 text-[12.5px] font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Reload
        </button>
      </div>
    );
  }
}
