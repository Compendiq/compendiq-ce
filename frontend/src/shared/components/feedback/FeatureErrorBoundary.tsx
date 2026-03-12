import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  /** Human-readable name shown in the fallback UI (e.g. "Editor", "Article Viewer"). */
  featureName: string;
  /** Optional callback invoked when the user clicks "Try Again". */
  onReset?: () => void;
}

interface FeatureErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * A granular error boundary designed to wrap individual feature components
 * (Editor, ArticleViewer, MermaidDiagram, etc.) so that a crash in one
 * feature does not take down the entire page.
 *
 * Renders a glassmorphic fallback card with the feature name, error details,
 * and a "Try Again" button that resets the boundary.
 */
export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  constructor(props: FeatureErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[FeatureErrorBoundary] ${this.props.featureName} crashed:`,
      error,
      errorInfo,
    );
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="rounded-xl border border-white/10 bg-card/80 p-6 text-center backdrop-blur-md"
          data-testid="feature-error-fallback"
        >
          <div className="mb-3 flex justify-center">
            <div className="rounded-full bg-destructive/15 p-2.5">
              <AlertTriangle size={24} className="text-destructive" />
            </div>
          </div>
          <h3 className="mb-1 text-base font-semibold text-foreground">
            {this.props.featureName} failed to load
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            An unexpected error occurred in this component. The rest of the page
            is still usable.
          </p>
          {this.state.error && (
            <pre className="mb-4 overflow-auto rounded-md bg-foreground/5 p-3 text-left text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw size={14} />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
