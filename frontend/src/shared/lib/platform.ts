/**
 * Platform detection utilities.
 *
 * Centralises platform checks so every consumer (hooks, components, etc.)
 * uses the same logic instead of maintaining local copies.
 */

/**
 * Detect whether the OS is macOS (to choose Cmd vs Ctrl).
 * Uses `navigator.userAgentData` when available, with a `navigator.userAgent` fallback.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Modern API (Chromium 90+)
  if ('userAgentData' in navigator && (navigator as Record<string, unknown>).userAgentData) {
    const uad = (navigator as Record<string, unknown>).userAgentData as { platform?: string };
    if (uad.platform) return uad.platform === 'macOS';
  }
  // Fallback to userAgent (works in all browsers)
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}
