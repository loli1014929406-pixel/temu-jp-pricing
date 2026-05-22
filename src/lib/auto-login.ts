const AUTO_LOGIN_SUPPRESSED_KEY = "temu-jp-pricing:auto-login-suppressed";

function readStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

export function suppressAutoLogin() {
  try {
    readStorage()?.setItem(AUTO_LOGIN_SUPPRESSED_KEY, "1");
  } catch {
    // If storage is unavailable, sign-out should still continue.
  }
}

export function clearAutoLoginSuppression() {
  try {
    readStorage()?.removeItem(AUTO_LOGIN_SUPPRESSED_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function isAutoLoginSuppressed() {
  try {
    return readStorage()?.getItem(AUTO_LOGIN_SUPPRESSED_KEY) === "1";
  } catch {
    return false;
  }
}
