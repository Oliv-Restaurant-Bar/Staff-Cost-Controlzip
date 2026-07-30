/**
 * useUgEventDays — Tages-Flags «UG/Event offen» des aktiven Mandanten.
 *
 * Toggle arbeitet mit FUNKTIONALEN Updates (nie Closure-Stand) und
 * serialisiert die Schreibzugriffe über eine Single-Flight-Queue mit
 * Revisionsprüfung: gespeichert wird immer der NEUESTE gewünschte Stand;
 * veraltete Schreibläufe committen nicht (kein Out-of-order last-write-wins).
 * Schlägt der letzte Schreibversuch fehl, wird der echte DB-Stand neu geladen.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useTenant } from '@/contexts/TenantContext';
import { loadUgEventDays, saveUgEventDays } from '@/lib/ug-event-days-db';

export function useUgEventDays() {
  const { tenantId } = useTenant();
  const [eventDays, setEventDays] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Revision des gewünschten Stands + zuletzt GESPEICHERTE Revision + Queue.
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const desired = useRef<Set<string>>(new Set());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const tenantRef = useRef(tenantId);

  useEffect(() => {
    let cancelled = false;
    tenantRef.current = tenantId;
    revision.current = 0;
    savedRevision.current = 0;
    desired.current = new Set();
    setLoading(true);
    setEventDays(new Set());
    (async () => {
      const loaded = await loadUgEventDays(tenantId);
      if (!cancelled && tenantRef.current === tenantId && revision.current === 0) {
        desired.current = loaded;
        setEventDays(loaded);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  const toggle = useCallback(
    (dateStr: string) => {
      const tenant = tenantRef.current;
      // Gewünschten Stand funktional fortschreiben (nie Closure-Stand).
      const next = new Set(desired.current);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      desired.current = next;
      const myRevision = ++revision.current;
      setEventDays(next); // optimistisch

      // Single-Flight: Schreibläufe strikt nacheinander; veraltete überspringen.
      queue.current = queue.current.then(async () => {
        if (tenantRef.current !== tenant) return; // Mandant gewechselt
        if (revision.current !== myRevision) return; // neuere Absicht vorhanden
        try {
          await saveUgEventDays(tenant, desired.current);
          savedRevision.current = myRevision;
        } catch (e) {
          // Nur reagieren, wenn dies noch der letzte gewollte Stand ist.
          if (revision.current === myRevision && tenantRef.current === tenant) {
            const real = await loadUgEventDays(tenant);
            if (revision.current === myRevision && tenantRef.current === tenant) {
              desired.current = real;
              setEventDays(real);
            }
            toast.error(e instanceof Error ? e.message : 'Event-Flag konnte nicht gespeichert werden');
          }
        }
      });
    },
    [],
  );

  return { eventDays, loading, toggle };
}
