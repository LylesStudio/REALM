const FALLBACK = "/";

/**
 * Only accept same-origin path destinations for post-login navigation.
 * URL parsing also rejects protocol-relative and browser-special backslash forms.
 */
export function safeLoginReturnTo(value: string | null | undefined, origin = "http://realm.local"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return FALLBACK;
  }
  try {
    const destination = new URL(value, origin);
    const base = new URL(origin);
    if (destination.origin !== base.origin) return FALLBACK;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return FALLBACK;
  }
}
