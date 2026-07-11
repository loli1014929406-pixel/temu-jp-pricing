import { useEffect } from "react";

type DraftEnvelope<T> = {
  value: T;
  savedAt: string;
};

function getStorage(storageName: "localStorage" | "sessionStorage") {
  try {
    return typeof window === "undefined" ? null : window[storageName];
  } catch {
    return null;
  }
}

function parseDraft<T>(rawValue: string | null): T | null {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as Partial<DraftEnvelope<T>> | T;
    if (
      parsed &&
      typeof parsed === "object" &&
      "value" in parsed &&
      "savedAt" in parsed
    ) {
      return (parsed as DraftEnvelope<T>).value;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function readDraft<T>(key: string): T | null {
  if (!key) return null;

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      const draft = parseDraft<T>(getStorage(storageName)?.getItem(key) ?? null);
      if (draft !== null) return draft;
    } catch {
      // Storage can be blocked in some browser modes; the in-memory state still works.
    }
  }

  return null;
}

export function writeDraft<T>(key: string, value: T) {
  if (!key) return;

  const envelope: DraftEnvelope<T> = {
    value,
    savedAt: new Date().toISOString(),
  };
  const rawValue = JSON.stringify(envelope);

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      getStorage(storageName)?.setItem(key, rawValue);
    } catch {
      // Best effort; if one storage fails, the other may still succeed.
    }
  }
}

export function clearDraft(key: string) {
  if (!key) return;

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      getStorage(storageName)?.removeItem(key);
    } catch {
      // Best effort cleanup.
    }
  }
}

export function isSameDraft<T>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * @todo (Technical Debt) Migrate draft persistence from localStorage to Supabase to support cross-device session continuity.
 */
export function useDraftPersistence<T>(
  key: string,
  value: T,
  options: { enabled?: boolean; shouldPersist?: (value: T) => boolean } = {},
) {
  const { enabled = true, shouldPersist } = options;

  useEffect(() => {
    if (enabled) {
      if (shouldPersist && !shouldPersist(value)) {
        clearDraft(key);
      } else {
        writeDraft(key, value);
      }
    }
  }, [enabled, key, value, shouldPersist]);
}
