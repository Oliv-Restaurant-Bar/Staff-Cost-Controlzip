/**
 * Returns the base URL to use when generating shared links (staff schedule,
 * guest links, department tokens).
 *
 * Priority:
 *  1. VITE_PUBLIC_URL env var (set in the Vercel project's environment variables →
 *     always points to the stable deployed domain)
 *  2. window.location.origin  (fallback — only correct when already on the deployed domain)
 *
 * Why this matters:
 *  - Local dev (localhost) and per-deployment Vercel preview URLs are not stable
 *    or not reachable from an employee's phone, so links copied from there break.
 *  - The project's Vercel domain is always reachable.
 */
export function getPublicBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_URL as string | undefined;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/$/, '');
  }
  return window.location.origin;
}
