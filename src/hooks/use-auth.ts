import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";
import { reportAppError } from "../lib/diagnostics";
import { setAsyncCacheScope } from "../lib/async-cache";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  function updateSession(nextSession: Session | null) {
    setAsyncCacheScope(nextSession?.user.id);
    setSession(nextSession);
    setLoading(false);
  }

  useEffect(() => {
    if (supabaseConfigError) {
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        reportAppError(error, "auth:get-session");
      }
      updateSession(error ? null : data.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      updateSession(nextSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  return {
    session,
    user: session?.user ?? null,
    loading,
  } satisfies {
    session: Session | null;
    user: User | null;
    loading: boolean;
  };
}
