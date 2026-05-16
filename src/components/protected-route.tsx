import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";

type ProtectedRouteProps = {
  user: User | null;
  loading: boolean;
  children: ReactNode;
};

export function ProtectedRoute({
  user,
  loading,
  children,
}: ProtectedRouteProps) {
  if (loading) {
    return <div className="p-6 text-sm text-slate-500">加载中...</div>;
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return children;
}
