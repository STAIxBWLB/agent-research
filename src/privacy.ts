/** Canonical URL and key-like markers for persisted text; path and env rules are caller-specific. */
const URL_KEY_SCANS: readonly (readonly [string, RegExp])[] = [
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:mailto|urn|file|data):/i],
  ["key-like token", /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{12,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{16,}/],
  ["key-like token", /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/],
];
export function urlOrKeyLike(value: string): string | undefined {
  return URL_KEY_SCANS.find(([, pattern]) => pattern.test(value))?.[0];
}
