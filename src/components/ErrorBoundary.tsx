import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** If provided, shown in the error card header */
  label?: string;
  /**
   * When this value changes (e.g. location.pathname) while an error is
   * currently displayed, the boundary resets itself automatically.
   * Prevents a navigation-time crash (e.g. from a race condition when
   * leaving a chart/dialog page) from "trapping" the user on the error
   * screen even though they've long since clicked through to a different,
   * unaffected page — "Erneut versuchen" (Retry) also remains available
   * as a manual fallback.
   */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error.message);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const { label = 'Seite' } = this.props;
      const msg = this.state.error?.message ?? 'Unbekannter Fehler';

      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-8">
          <div className="max-w-lg w-full rounded-xl border-2 border-destructive/30 bg-destructive/5 p-8 space-y-4 text-center shadow-sm">
            <div className="text-5xl">⚠️</div>
            <h1 className="text-xl font-bold text-destructive">
              {label} konnte nicht geladen werden
            </h1>
            <p className="text-sm text-muted-foreground">
              Ein unerwarteter Fehler ist aufgetreten. Bitte laden Sie die Seite neu
              oder versuchen Sie es erneut.
            </p>
            {msg && (
              <pre className="text-left text-xs bg-muted text-destructive rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                {msg}
              </pre>
            )}
            <div className="flex justify-center gap-3">
              <button
                onClick={this.handleRetry}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Erneut versuchen
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Seite neu laden
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
