import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="nm-card mx-auto mt-12 max-w-lg p-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-destructive/15 p-3">
              <AlertTriangle size={32} className="text-destructive" />
            </div>
          </div>
          <h2 className="mb-2 text-xl font-semibold text-foreground">
            Something went wrong
          </h2>
          <p className="mb-6 text-sm text-muted-foreground">
            An unexpected error occurred. Please try again.
          </p>
          {this.state.error && (
            <pre className="mb-6 overflow-auto rounded-md bg-foreground/5 p-3 text-left text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="nm-button-primary"
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
