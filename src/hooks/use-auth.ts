import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  function updateSession(nextSession: Session | null) {
    setSession((currentSession) => {
      if (currentSession?.user.id === nextSession?.user.id) {
        return currentSession;
      }
      return nextSession;
    });
    setLoading(false);
  }

  useEffect(() => {
    if (supabaseConfigError) {
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();

    void supabase.auth.getSession().then(({ data }) => {
      updateSession(data.session);
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
