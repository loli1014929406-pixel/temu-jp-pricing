import { useEffect, useRef } from "react";

export function useAutoDismiss(
  value: string | boolean,
  dismiss: () => void,
  delayMs = 5000,
) {
  const dismissRef = useRef(dismiss);

  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  useEffect(() => {
    if (!value) return;

    const timer = window.setTimeout(() => dismissRef.current(), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
}
