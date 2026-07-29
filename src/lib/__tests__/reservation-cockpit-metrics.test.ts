// @vitest-environment node
/**
 * Tests der Cockpit-Reservationskennzahlen: zentrale Zählregel + Aggregation
 * (Σ Personen «Reservierte Gäste», Gruppen ab N Pax mit Personen), inkl.
 * Upsert-nach-Res.Nr.-Semantik (Statuswechsel fällt aus der Zählung) und
 * Verhalten für zukünftige Zeiträume.  Reine Logik, ohne DB.
 *
 * node-Env (kein jsdom → kein canvas/libuuid-Crash). Der Supabase-Client wird
 * gemockt, da die getesteten Module ihn beim Import ziehen (die Tests rufen aber
 * nur die reinen Funktionen auf, keine DB-Operationen).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({}) },
}));
vi.mock('@/lib/supabase-db', () => ({
  loadSetting: async () => null,
  saveSetting: async () => {},
}));
import {
  aggregateReservationMetrics, type ReservationMetricRow,
} from '@/lib/reservation-cockpit-metrics';
import {
  DEFAULT_RESERVATION_COUNTING, normalizeCountingSettings, statusCounts,
  type ReservationCountingSettings,
} from '@/lib/reservation-cockpit-settings';
import {
  dedupeReservationsByExternalId, normalizeStatus,
} from '@/lib/reservation-import-parser';

const S = DEFAULT_RESERVATION_COUNTING;
const row = (party: number | null, status: string): ReservationMetricRow =>
  ({ party_size: party, status_normalized: normalizeStatus(status) });

// ── Zählregel (zentrale Einstellung) ─────────────────────────────────────────

describe('Zählregel (Status)', () => {
  it('Default zählt Abgeschlossen + Bestätigt, schliesst Storno/No-show/Abgelehnt/Nicht beantwortet aus', () => {
    expect(statusCounts(normalizeStatus('Abgeschlossen'), S)).toBe(true);
    expect(statusCounts(normalizeStatus('Bestätigt'), S)).toBe(true);
    expect(statusCounts(normalizeStatus('Storniert'), S)).toBe(false);
    expect(statusCounts(normalizeStatus('No-show'), S)).toBe(false);
    expect(statusCounts(normalizeStatus('Abgelehnt'), S)).toBe(false);
    expect(statusCounts(normalizeStatus('Nicht beantwortet'), S)).toBe(false);
  });

  it('normalizeCountingSettings repariert Defekte (leer → Default, unbekannt weg, Schwelle validiert)', () => {
    expect(normalizeCountingSettings(null)).toEqual(DEFAULT_RESERVATION_COUNTING);
    expect(normalizeCountingSettings({ countedStatuses: [] }).countedStatuses)
      .toEqual(DEFAULT_RESERVATION_COUNTING.countedStatuses);
    const fixed = normalizeCountingSettings({ countedStatuses: ['completed', 'bogus' as any, 'completed'], groupThreshold: 0 });
    expect(fixed.countedStatuses).toEqual(['completed']);
    expect(fixed.groupThreshold).toBe(20); // 0 ungültig → Default
    expect(normalizeCountingSettings({ groupThreshold: 8.9 as any }).groupThreshold).toBe(8);
  });
});

// ── Aggregation: reservierte Gäste + Gruppen ───────────────────────────────────

describe('aggregateReservationMetrics', () => {
  it('Σ Personen korrekt (nur gezählte Status)', () => {
    const rows = [row(4, 'Abgeschlossen'), row(6, 'Bestätigt'), row(2, 'Abgeschlossen')];
    const m = aggregateReservationMetrics(rows, S, true);
    expect(m.reservedGuests).toBe(12);
  });

  it('Storno wird NICHT gezählt (weder Personen noch Gruppen)', () => {
    const rows = [row(4, 'Abgeschlossen'), row(25, 'Storniert')];
    const m = aggregateReservationMetrics(rows, S, true);
    expect(m.reservedGuests).toBe(4);            // 25 des Stornos fällt raus
    expect(m.largeGroupCount).toBe(0);
    expect(m.largeGroupPersons).toBe(0);
  });

  it('Gruppen-Zähler + Personen korrekt (Schwelle inklusiv, >=20)', () => {
    const rows = [
      row(20, 'Abgeschlossen'), // zählt (=Schwelle)
      row(25, 'Bestätigt'),     // zählt
      row(25, 'Abgeschlossen'), // zählt → 3 Gruppen, 20+25+25 = 70 Personen
      row(19, 'Abgeschlossen'), // knapp drunter → keine Gruppe
    ];
    const m = aggregateReservationMetrics(rows, S, true);
    expect(m.largeGroupCount).toBe(3);
    expect(m.largeGroupPersons).toBe(70);
    expect(m.reservedGuests).toBe(89);
  });

  it('konfigurierbare Schwelle wird berücksichtigt', () => {
    const rows = [row(10, 'Abgeschlossen'), row(15, 'Bestätigt')];
    const custom: ReservationCountingSettings = { countedStatuses: ['completed', 'confirmed'], groupThreshold: 10 };
    const m = aggregateReservationMetrics(rows, custom, true);
    expect(m.largeGroupCount).toBe(2);
    expect(m.largeGroupPersons).toBe(25);
  });

  it('keine Datenbasis (hasData=false) → alle Felder null (nie still 0)', () => {
    const m = aggregateReservationMetrics([], S, false);
    expect(m).toEqual({ reservedGuests: null, largeGroupCount: null, largeGroupPersons: null });
  });

  it('leere aber vorhandene Daten (hasData=true) → 0, nicht null', () => {
    const m = aggregateReservationMetrics([], S, true);
    expect(m).toEqual({ reservedGuests: 0, largeGroupCount: 0, largeGroupPersons: 0 });
  });
});

// ── Upsert nach Res.Nr.: Statuswechsel fällt aus der Zählung ──────────────────

describe('Upsert nach Res.Nr. (Statuswechsel)', () => {
  // dedupeReservationsByExternalId behält je Res.Nr. die ZULETZT vorkommende
  // Zeile → derselbe Effekt wie ein erneuter Voll-Export in die DB.
  const mk = (id: string, party: number, status: string) => ({
    externalReservationId: id, partySize: party,
    statusNormalized: normalizeStatus(status),
  }) as any;

  it('Bestätigt → Storniert: die Reservation fällt bei erneutem Export aus der Zählung', () => {
    const reexport = [mk('R1', 30, 'Bestätigt'), mk('R1', 30, 'Storniert'), mk('R2', 5, 'Abgeschlossen')];
    const { deduped, duplicateKeyMerged } = dedupeReservationsByExternalId(reexport);
    expect(duplicateKeyMerged).toBe(1);
    const rows: ReservationMetricRow[] = deduped.map(r => ({ party_size: r.partySize, status_normalized: r.statusNormalized }));
    const m = aggregateReservationMetrics(rows, S, true);
    // R1 zuletzt Storniert → nicht gezählt; nur R2 (5 Personen), keine Gruppe.
    expect(m.reservedGuests).toBe(5);
    expect(m.largeGroupCount).toBe(0);
  });
});

// ── Zukünftige Perioden ────────────────────────────────────────────────────────

describe('zukünftige Reservationen', () => {
  it('werden gezählt wie vergangene (kein «heute»-Klemmen in der Aggregation)', () => {
    // Die Aggregation kennt kein Datum → zukünftige Zeilen zählen identisch.
    const rows = [row(50, 'Bestätigt'), row(3, 'Abgeschlossen')];
    const m = aggregateReservationMetrics(rows, S, true);
    expect(m.reservedGuests).toBe(53);
    expect(m.largeGroupCount).toBe(1);
    expect(m.largeGroupPersons).toBe(50);
  });
});
