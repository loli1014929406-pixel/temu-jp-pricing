import { Component, type ErrorInfo, type ReactNode } from "react";

export type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }

      return (
        <section className="grid gap-4 rounded-lg bg-white p-6 shadow-panel">
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            当前页面发生异常，已停止继续渲染。
          </div>

          <div className="grid gap-2">
            <h1 className="text-xl font-semibold text-ink">页面暂时无法显示</h1>
            <p className="text-sm text-slate-500">
              这通常是一次临时问题。重新加载页面后，大多数情况下可以继续使用。
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary w-fit"
            onClick={this.handleReload}
          >
            重新加载页面
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}
