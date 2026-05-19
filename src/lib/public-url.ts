/**
 * Returns the base URL to use when generating shared links (staff schedule,
 * guest links, department tokens).
 *
 * Priority:
 *  1. VITE_PUBLIC_URL env var (set in .replit → always points to the deployed domain)
 *  2. window.location.origin  (fallback — only correct when already on the deployed domain)
 *
 * Why this matters:
 *  - In the Replit editor the preview runs on *.riker.replit.dev which is ONLY
 *    reachable while the workspace is active.  Links copied from there show
 *    "Run this app to see the results here." on mobile.
 *  - The deployed static site runs on *.replit.app which is always reachable.
 */
export function getPublicBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_URL as string | undefined;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/$/, '');
  }
  return window.location.origin;
}
