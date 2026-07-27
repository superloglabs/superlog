import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportBrowserException } from "./instrumentation.ts";

type BrowserErrorBoundaryProps = {
  children: ReactNode;
};

type BrowserErrorBoundaryState = {
  failed: boolean;
};

export class BrowserErrorBoundary extends Component<
  BrowserErrorBoundaryProps,
  BrowserErrorBoundaryState
> {
  state: BrowserErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): BrowserErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportBrowserException(error, "react.render", {
      "react.component_stack": info.componentStack ?? "",
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Superlog hit an unexpected error</h1>
          <p className="mt-2 text-[13px] text-muted">
            We recorded the details. Reload the page to continue.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex h-8 items-center justify-center rounded-md bg-fg px-3 text-[12px] font-medium text-bg transition-opacity hover:opacity-85"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
}
