import { Component, type ReactNode, type ErrorInfo } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  /**
   * Optional fallback UI to render when a descendant throws during render.
   * If omitted, a minimal default error message is shown.
   */
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Generic React class error boundary.
 *
 * Usage:
 *   <ErrorBoundary fallback={<ShareFallback />}>
 *     <ShareLayout />
 *   </ErrorBoundary>
 *
 * When any descendant throws during render (or in a lifecycle method),
 * getDerivedStateFromError flips hasError to true and the boundary renders
 * the `fallback` prop (or a minimal default) instead of the subtree.
 *
 * Created for Phase 29 Gap 2: the /share/:token visitor subtree had no error
 * boundary, so a single bad chunk or malformed payload could blank #root
 * entirely (blank white screen). The local boundary around <ShareLayout />
 * constrains the failure surface to the share subtree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught render error:', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }
      return (
        <div className="p-6 text-sm text-neutral-600 dark:text-neutral-400">
          Something went wrong.
        </div>
      );
    }
    return this.props.children;
  }
}
