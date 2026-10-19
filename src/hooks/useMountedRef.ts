import { useEffect, useRef } from "react";

/**
 * Returns a ref that stays true as long as the component is mounted.
 *
 * For data-loading effects, the project already has the local
 * `let alive = true; ... return () => { alive = false }` pattern (see e.g.
 * MonatsreportPage.tsx) — that's enough for a single useEffect.
 *
 * For multi-step async event handlers (click handlers with several awaits,
 * e.g. PDF/file exports) that can keep running across a navigation, the
 * same protection is needed, but without re-declaring the `alive` flag on
 * every call site. This hook makes exactly that reusable:
 *
 *   const mountedRef = useMountedRef();
 *   ...
 *   const res = await longOperation();
 *   if (!mountedRef.current) return; // user navigated away meanwhile
 *   setState(res);
 *
 * Without this guard, an async handler can still set state on an already
 * unmounted page after a route change, or keep working with stale refs —
 * in React 18 that's not a crash by itself, but it's the actual cause
 * behind hard-to-reproduce follow-on errors when navigating (crash reports
 * "Seite konnte nicht geladen werden").
 */
export function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  return mountedRef;
}
