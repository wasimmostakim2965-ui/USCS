/**
 * The error boundary.
 *
 * Kept beside the components rather than inside them: it is not a piece of the
 * design system, it is the net under it.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./index.js";

/**
 * Catches a render error anywhere below it and shows a page-shaped apology
 * instead of unmounting the tree.
 *
 * Without this, one throw inside one page takes the sidebar, the header and
 * every other route with it — a blank white screen with no way back, which is
 * the least honest thing a dashboard can do. The boundary keeps the shell and
 * offers a retry, so the failure is bounded and named.
 *
 * It reports the error to `onError` (a log sink) rather than swallowing it, and
 * the retry re-mounts the subtree, so a transient fault does not need a reload.
 */
export class ErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    /** Where the error goes. Never rendered to the user. */
    readonly onError?: (error: Error, info: ErrorInfo) => void;
    /** What to show. Defaults to the Cloud Wai apology. */
    readonly fallback?: (retry: () => void) => ReactNode;
  },
  { readonly failed: Error | null }
> {
  override state: { readonly failed: Error | null } = { failed: null };

  static getDerivedStateFromError(failed: Error): { failed: Error } {
    return { failed };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ failed: null });
  };

  override render(): ReactNode {
    const { failed } = this.state;
    if (!failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry);
    return (
      <div className="page">
        <header className="page__head">
          <div>
            <h1 className="page__title">This page stopped</h1>
            <p className="page__sub">
              Something failed while rendering it. Nothing was changed, and the rest of the
              dashboard still works.
            </p>
          </div>
          <div className="page__actions">
            <Button variant="primary" onClick={this.retry}>
              Try again
            </Button>
          </div>
        </header>
        <Card>
          <p className="small muted" style={{ margin: 0 }}>
            The error was <span className="mono">{failed.message || failed.name}</span>.
          </p>
        </Card>
      </div>
    );
  }
}
