/**
 * useHeuteWidgets — IO-Hook der zusätzlichen «Heute»-Widgets (Startseite).
 * ========================================================================
 * STRIKT READ-ONLY: lädt NUR die Quellen der tatsächlich ausgewählten
 * Widgets (Promise.allSettled — ein Fehler reisst die anderen nicht mit):
 *  - reservationen_heute: fetchReservationsInRange (heute) → sofort auf die
 *    PII-freie Projektion {count, persons} reduziert (countInRange +
 *    isActiveStatus — DIESELBE Zähllogik wie die Reservations-Auswertung).
 *  - personalausfaelle:   loadScheduleForMonth (heutiger Monat) → geplant?/
 *    Abwesenheiten heute. Kein Plan ⇒ dayPlanned=false («—», nie 0).
 *  - warenrechnungen:     loadMonthInvoices (laufender Monat, KV-Liste).
 *  - kreditoren:          loadOpImports → neueste aktive OP-Liste.
 * Fehler je Quelle bleiben sichtbar (error-Text im Widget), nie stille 0.
 * Stale-Guard bei Tenant-/Auswahlwechsel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { useTenant } from '@/contexts/TenantContext';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { countInRange, isActiveStatus } from '@/lib/reservation-dashboard';
import { loadMonthInvoices } from '@/lib/waren-db';
import { loadOpImports } from '@/lib/op-liste-db';
import { loadScheduleForMonth } from '@/lib/supabase-db';
import type { HeuteWidgetId } from '@/lib/start-widgets';
import type {
  KreditorenData,
  PersonalausfaelleData,
  ReservationenHeuteData,
  WarenrechnungenData,
} from '@/lib/start-widgets';

interface SourceState<T> {
  data: T | null;
  error: string | null;
}

export interface HeuteWidgetsData {
  reservationenHeute: SourceState<ReservationenHeuteData>;
  personalausfaelle: SourceState<PersonalausfaelleData>;
  warenrechnungen: SourceState<WarenrechnungenData>;
  kreditoren: SourceState<KreditorenData>;
  loading: boolean;
}

const EMPTY: HeuteWidgetsData = {
  reservationenHeute: { data: null, error: null },
  personalausfaelle: { data: null, error: null },
  warenrechnungen: { data: null, error: null },
  kreditoren: { data: null, error: null },
  loading: false,
};

function errMsg(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function useHeuteWidgets(
  enabled: boolean,
  selected: readonly HeuteWidgetId[],
): HeuteWidgetsData {
  const { tenantId } = useTenant();
  const [state, setState] = useState<HeuteWidgetsData>(EMPTY);
  const generation = useRef(0);

  // Stabiler Abhängigkeits-Schlüssel: nur die Daten-Widgets zählen.
  const wantRes = selected.includes('reservationen_heute');
  const wantAbs = selected.includes('personalausfaelle');
  const wantWaren = selected.includes('warenrechnungen');
  const wantOp = selected.includes('kreditoren');
  const wantAny = wantRes || wantAbs || wantWaren || wantOp;

  const load = useCallback(async () => {
    const gen = ++generation.current;
    if (!wantAny) {
      setState(EMPTY);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const now = new Date();
    const todayIso = format(now, 'yyyy-MM-dd');
    const monthKey = format(now, 'yyyy-MM');

    const [resR, absR, warenR, opR] = await Promise.allSettled([
      wantRes ? fetchReservationsInRange(tenantId, todayIso, todayIso) : Promise.resolve(null),
      wantAbs ? loadScheduleForMonth(now, tenantId) : Promise.resolve(null),
      wantWaren ? loadMonthInvoices(tenantId, monthKey) : Promise.resolve(null),
      wantOp ? loadOpImports(tenantId) : Promise.resolve(null),
    ]);
    if (gen !== generation.current) return; // veralteter Request → verwerfen

    const next: HeuteWidgetsData = { ...EMPTY, loading: false };

    if (wantRes) {
      if (resR.status === 'fulfilled' && resR.value) {
        // Sofortige PII-freie Projektion — Namen/Kontakte verlassen den Hook nie.
        const counted = countInRange(resR.value, todayIso, todayIso, isActiveStatus);
        next.reservationenHeute = {
          data: { count: counted.reservations, persons: counted.persons > 0 ? counted.persons : null },
          error: null,
        };
      } else if (resR.status === 'rejected') {
        next.reservationenHeute = { data: null, error: errMsg(resR.reason, 'Reservationen konnten nicht geladen werden.') };
      }
    }

    if (wantAbs) {
      if (absR.status === 'fulfilled' && absR.value) {
        const schedule = absR.value as Record<string, { frühAbsence?: string | null; spätAbsence?: string | null }>;
        let dayPlanned = false;
        let absenceCount = 0;
        for (const [key, day] of Object.entries(schedule)) {
          if (!key.endsWith(`-${todayIso}`) || !day) continue;
          dayPlanned = true;
          if (day.frühAbsence || day.spätAbsence) absenceCount += 1;
        }
        next.personalausfaelle = { data: { dayPlanned, absenceCount }, error: null };
      } else if (absR.status === 'rejected') {
        next.personalausfaelle = { data: null, error: errMsg(absR.reason, 'Dienstplan konnte nicht geladen werden.') };
      }
    }

    if (wantWaren) {
      if (warenR.status === 'fulfilled' && warenR.value) {
        const invoices = warenR.value;
        const totalNet = invoices.reduce(
          (sum, e) => sum + (typeof e.amountNet === 'number' && Number.isFinite(e.amountNet) ? e.amountNet : 0),
          0,
        );
        next.warenrechnungen = { data: { count: invoices.length, totalNet }, error: null };
      } else if (warenR.status === 'rejected') {
        next.warenrechnungen = { data: null, error: errMsg(warenR.reason, 'Warenrechnungen konnten nicht geladen werden.') };
      }
    }

    if (wantOp) {
      if (opR.status === 'fulfilled' && opR.value) {
        const res = opR.value;
        if (res.error) {
          next.kreditoren = { data: null, error: res.error };
        } else {
          const latest = res.imports[0] ?? null; // bereits snapshot_date-absteigend sortiert
          next.kreditoren = {
            data: {
              tableAvailable: !res.tableMissing,
              latest: latest
                ? {
                    snapshotDate: latest.snapshotDate,
                    totalOpenAmount: latest.totalOpenAmount,
                    totalItems: latest.totalItems,
                  }
                : null,
            },
            error: null,
          };
        }
      } else if (opR.status === 'rejected') {
        next.kreditoren = { data: null, error: errMsg(opR.reason, 'OP-Liste konnte nicht geladen werden.') };
      }
    }

    setState(next);
  }, [tenantId, wantRes, wantAbs, wantWaren, wantOp, wantAny]);

  useEffect(() => {
    if (enabled) void load();
    else setState(EMPTY);
  }, [enabled, load]);

  return state;
}
