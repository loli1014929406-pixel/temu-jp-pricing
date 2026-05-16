import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (supabaseConfigError) {
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
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
