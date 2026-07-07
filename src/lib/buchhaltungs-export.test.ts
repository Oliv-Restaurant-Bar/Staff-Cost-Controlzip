// @vitest-environment node
/**
 * Tests für den Buchhaltungs-Export-Assistenten (buchhaltungs-export.ts):
 * Fingerprint/Veraltet-Erkennung, Checkliste, Monatsprüfung, Buchungsvorschau,
 * Export-Historie/Versionierung, Statusableitung und Blob-Merge/Normalisierung.
 */
import { describe, it, expect } from 'vitest';
import {
  addExportRecord,
  buildExportChecklist,
  buildMonatspruefung,
  computeMonthFingerprint,
  createExportRecord,
  deriveExportStatus,
  exportChecklistOk,
  exportsForMonth,
  latestExportForMonth,
  latestRelevantExportMonth,
  nextExportVersion,
  summarizeBuchungsvorschau,
  VORSCHAU_KATEGORIEN,
} from './buchhaltungs-export';
import { buildTabelle2Rows } from './tagesabschluss-export';
import {
  buildTagesabschlussRows,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  mergeTagesabschlussBlobs,
  normalizeTagesabschlussBlob,
  upsertExpense,
  upsertManualDay,
  type BuchhaltungsExportRecord,
  type GnDayClosing,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
} from './tagesabschluss';

const NOW = '2026-07-06T10:00:00.000Z';
const LATER = '2026-07-07T09:00:00.000Z';
const MONTH_KEY = '2026-07';

function makeClosing(date: string, over: Partial<GnDayClosing> = {}): GnDayClosing {
  return {
    date,
    grossRevenue: 1000,
    netRevenue: 925.07,
    tip: null,
    taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
    payments: [
      { name: 'Bar', count: 10, amount: 300 },
      { name: 'Mastercard', count: 8, amount: 400 },
      { name: 'VISA', count: 3, amount: 150 },
      { name: 'TWINT', count: 4, amount: 100 },
      { name: 'Rechnung', count: 1, amount: 30 },
      { name: 'Gutschein', count: 1, amount: 20 },
    ],
    accountingLines: [],
    paymentAccounts: [],
    ...over,
  };
}

function withClosedDays(blob: TagesabschlussBlob, dates: string[]): TagesabschlussBlob {
  const abschluesse = { ...blob.abschluesse };
  for (const d of dates) {
    abschluesse[d] = {
      status: 'abgeschlossen',
      closedAt: NOW,
      closedBy: 'test@oliv.ch',
      fixedKassensaldo: null,
      updatedAt: NOW,
      history: [{ at: NOW, by: 'test@oliv.ch', action: 'abschluss', status: 'abgeschlossen' }],
    };
  }
  return { ...blob, abschluesse };
}

function withClosedMonth(blob: TagesabschlussBlob, monthKey: string): TagesabschlussBlob {
  return {
    ...blob,
    monatsabschluesse: {
      ...blob.monatsabschluesse,
      [monthKey]: {
        status: 'abgeschlossen',
        closedAt: NOW,
        closedBy: 'test@oliv.ch',
        snapshot: {
          anfangsbestand: 500,
          endbestand: 800,
          umsatzTotal: 1000,
          bargeldTotal: 300,
          barausgabenTotal: 0,
          bankeinzahlungenTotal: 0,
          cashDiffTotal: 0,
          begruendeteDifferenzen: 0,
        },
        updatedAt: NOW,
      },
    },
  };
}

function reviewedSettings(over: Partial<TagesabschlussExportSettings> = {}): TagesabschlussExportSettings {
  return {
    ...defaultExportSettings(NOW),
    reviewed: true,
    ...over,
  };
}

// ── Fingerprint (§10) ────────────────────────────────────────────────────────

describe('computeMonthFingerprint', () => {
  it('ist deterministisch für identische Blobs', () => {
    const a = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const b = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    expect(computeMonthFingerprint(a, MONTH_KEY)).toBe(computeMonthFingerprint(b, MONTH_KEY));
  });

  it('ändert sich bei Monats-Mutationen (manueller Wert, Barausgabe, Abschluss)', () => {
    const base = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const fp = computeMonthFingerprint(base, MONTH_KEY);

    const mutated = upsertManualDay(base, '2026-07-01', { bestandKasse: 123 }, LATER);
    expect(computeMonthFingerprint(mutated, MONTH_KEY)).not.toBe(fp);

    const withExpense = upsertExpense(base, {
      id: 'e1', date: '2026-07-02', amount: 50, konto: '6000', text: 'Blumen', updatedAt: LATER,
    });
    expect(computeMonthFingerprint(withExpense, MONTH_KEY)).not.toBe(fp);

    const reopened: TagesabschlussBlob = {
      ...base,
      abschluesse: {
        ...base.abschluesse,
        '2026-07-01': {
          ...base.abschluesse['2026-07-01'],
          status: 'wieder_geoeffnet',
          updatedAt: LATER,
          history: [
            ...base.abschluesse['2026-07-01'].history,
            { at: LATER, by: 'admin@oliv.ch', action: 'wiederoeffnung', reason: 'Fehler' },
          ],
        },
      },
    };
    expect(computeMonthFingerprint(reopened, MONTH_KEY)).not.toBe(fp);
  });

  it('ignoriert andere Monate, exportSettings und exportProtokolle', () => {
    const base = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const fp = computeMonthFingerprint(base, MONTH_KEY);

    const otherMonth = upsertManualDay(base, '2026-06-30', { bestandKasse: 99 }, LATER);
    expect(computeMonthFingerprint(otherMonth, MONTH_KEY)).toBe(fp);

    const withSettings: TagesabschlussBlob = { ...base, exportSettings: reviewedSettings() };
    expect(computeMonthFingerprint(withSettings, MONTH_KEY)).toBe(fp);

    const rec: BuchhaltungsExportRecord = {
      id: 'exp-x', monat: MONTH_KEY, version: 1, exportedAt: NOW, exportedBy: 'a@b.ch',
      anzahlBuchungen: 5, kassensaldoEnde: 100, fingerprint: fp, updatedAt: NOW,
    };
    expect(computeMonthFingerprint(addExportRecord(base, rec), MONTH_KEY)).toBe(fp);
  });

  it('bezieht den Anfangsbestand des Monats ein', () => {
    const base = emptyTagesabschlussBlob();
    const fp = computeMonthFingerprint(base, MONTH_KEY);
    const withAnker: TagesabschlussBlob = {
      ...base,
      anfangsbestand: { [MONTH_KEY]: { value: 500, updatedAt: NOW } },
    };
    expect(computeMonthFingerprint(withAnker, MONTH_KEY)).not.toBe(fp);
  });
});

// ── Checkliste (§2) ──────────────────────────────────────────────────────────

describe('buildExportChecklist', () => {
  it('blockiert bei offenem Monat ohne Anker (mehrere Items nicht ok)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const blob = emptyTagesabschlussBlob();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const items = buildExportChecklist(month, blob, MONTH_KEY);

    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    expect(byKey['anfangsbestand'].ok).toBe(false);
    expect(byKey['alle_tage_abgeschlossen'].ok).toBe(false);
    expect(byKey['kassensaldo_plausibel'].ok).toBe(false);
    expect(byKey['monatsabschluss'].ok).toBe(false);
    expect(byKey['zberichte'].ok).toBe(true); // Z-Bericht existiert
    expect(exportChecklistOk(items)).toBe(false);
  });

  it('ist vollständig ok bei abgeschlossenem Monat mit Anker', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    blob = withClosedMonth(blob, MONTH_KEY);
    blob = { ...blob, anfangsbestand: { [MONTH_KEY]: { value: 500, updatedAt: NOW } } };
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const items = buildExportChecklist(month, blob, MONTH_KEY);

    for (const item of items) {
      expect(item.ok, `${item.key}: ${item.detail}`).toBe(true);
    }
    expect(exportChecklistOk(items)).toBe(true);
  });

  it('meldet unbegründete Differenzen und fehlenden Monatsabschluss getrennt', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    blob = { ...blob, anfangsbestand: { [MONTH_KEY]: { value: 500, updatedAt: NOW } } };
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const items = buildExportChecklist(month, blob, MONTH_KEY);
    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    expect(byKey['monatsabschluss'].ok).toBe(false);
    expect(byKey['alle_tage_abgeschlossen'].ok).toBe(true);
    expect(exportChecklistOk(items)).toBe(false);
  });
});

// ── Monatsprüfung (§3) ───────────────────────────────────────────────────────

describe('buildMonatspruefung', () => {
  it('liefert die 9 Monats-Totale inkl. KK inkl. TWINT und Salden', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const blob = emptyTagesabschlussBlob();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const items = buildMonatspruefung(month);
    const byKey = Object.fromEntries(items.map(i => [i.key, i.value]));

    expect(items).toHaveLength(9);
    expect(byKey['umsatz']).toBe(1000);
    expect(byKey['kreditkarten']).toBe(650); // 400 + 150 Karten + 100 TWINT
    expect(byKey['debitoren']).toBe(30);
    expect(byKey['gutscheine_eingeloest']).toBe(20);
    expect(byKey['saldo_anfang']).toBe(500);
    expect(byKey['saldo_ende']).not.toBeNull();
  });

  it('zeigt Salden als null (—), wenn kein Anker bekannt ist', () => {
    const month = buildTagesabschlussRows(2026, 7, {}, emptyTagesabschlussBlob(), {});
    const byKey = Object.fromEntries(buildMonatspruefung(month).map(i => [i.key, i.value]));
    expect(byKey['saldo_anfang']).toBeNull();
    expect(byKey['saldo_ende']).toBeNull();
  });
});

// ── Buchungsvorschau (§4) ────────────────────────────────────────────────────

describe('summarizeBuchungsvorschau', () => {
  it('gruppiert die Tabelle2-Zeilen nach Kategorie (Brutto-Modell, keine Umsatz-Gruppe)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 200 }, NOW);
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-07-01', amount: 42.5, konto: '6000', text: 'Blumen', updatedAt: NOW,
    });
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const exp = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(exp.errors).toEqual([]);

    const vorschau = summarizeBuchungsvorschau(exp.rows);
    const byKat = Object.fromEntries(vorschau.gruppen.map(g => [g.kategorie, g]));

    expect(vorschau.gruppen.map(g => g.kategorie)).toEqual([...VORSCHAU_KATEGORIEN]);
    expect(byKat['barumsatz'].brutto).toBe(300);
    expect(byKat['kreditkarten'].anzahl).toBe(2); // Mastercard + VISA
    expect(byKat['kreditkarten'].brutto).toBe(550);
    expect(byKat['twint'].brutto).toBe(100);
    expect(byKat['debitoren'].brutto).toBe(30);
    expect(byKat['gutschein_eingeloest'].brutto).toBe(20);
    expect(byKat['bank'].brutto).toBe(200);
    expect(byKat['barausgabe'].anzahl).toBe(1);
    expect(byKat['barausgabe'].brutto).toBe(42.5);

    expect(vorschau.anzahlBuchungen).toBe(exp.rows.length);
    expect(vorschau.mwstTotal).toBe(0); // Brutto-Modell: keine MWST-Buchungen
    expect(vorschau.bruttoTotal).toBe(vorschau.nettoTotal);
  });

  it('weist unklassifizierte Zahlarten der Gruppe weitere_zahlungsarten zu', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 960 },
          { name: 'KD Tisch 5000', count: 1, amount: 40 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const exp = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(exp.errors).toEqual([]);
    const vorschau = summarizeBuchungsvorschau(exp.rows);
    const byKat = Object.fromEntries(vorschau.gruppen.map(g => [g.kategorie, g]));
    expect(byKat['weitere_zahlungsarten'].anzahl).toBe(1);
    expect(byKat['weitere_zahlungsarten'].brutto).toBe(40);
    expect(byKat['barumsatz'].brutto).toBe(960);
  });

  it('liefert leere Gruppen (0) für einen leeren Export', () => {
    const vorschau = summarizeBuchungsvorschau([]);
    expect(vorschau.anzahlBuchungen).toBe(0);
    expect(vorschau.gruppen.every(g => g.anzahl === 0 && g.netto === 0)).toBe(true);
  });
});

// ── Historie / Versionierung (§7/§8) ─────────────────────────────────────────

describe('Export-Historie und Versionierung', () => {
  it('vergibt fortlaufende Versionen je Monat und sortiert chronologisch', () => {
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    expect(nextExportVersion(blob, MONTH_KEY)).toBe(1);

    const r1 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: NOW,
      anzahlBuchungen: 12, kassensaldoEnde: 810.5,
    });
    expect(r1.version).toBe(1);
    expect(r1.monat).toBe(MONTH_KEY);
    expect(r1.fingerprint).toBe(computeMonthFingerprint(blob, MONTH_KEY));
    blob = addExportRecord(blob, r1);

    const r2 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'b@oliv.ch', now: LATER,
      anzahlBuchungen: 13, kassensaldoEnde: 810.5,
    });
    expect(r2.version).toBe(2);
    expect(r2.id).not.toBe(r1.id);
    blob = addExportRecord(blob, r2);

    const list = exportsForMonth(blob, MONTH_KEY);
    expect(list.map(r => r.version)).toEqual([1, 2]);
    expect(latestExportForMonth(blob, MONTH_KEY)?.id).toBe(r2.id);
    // Anderer Monat bleibt unberührt.
    expect(exportsForMonth(blob, '2026-06')).toEqual([]);
    expect(nextExportVersion(blob, '2026-06')).toBe(1);
  });
});

// ── Statusableitung (§10/§11) ────────────────────────────────────────────────

describe('deriveExportStatus', () => {
  it('offen → bereit → exportiert → veraltet', () => {
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('offen');

    blob = withClosedMonth(blob, MONTH_KEY);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('bereit');

    const rec = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: NOW,
      anzahlBuchungen: 12, kassensaldoEnde: 810.5,
    });
    blob = addExportRecord(blob, rec);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');

    // Nachträgliche Änderung im Monat → Export veraltet (§10).
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 50 }, LATER);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('veraltet');
  });

  it('bewertet nur den jüngsten Export (Neu-Export macht wieder aktuell)', () => {
    let blob = withClosedDays(withClosedMonth(emptyTagesabschlussBlob(), MONTH_KEY), ['2026-07-01']);
    const r1 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: NOW,
      anzahlBuchungen: 12, kassensaldoEnde: 810.5,
    });
    blob = addExportRecord(blob, r1);
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 50 }, LATER);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('veraltet');

    const r2 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: LATER,
      anzahlBuchungen: 13, kassensaldoEnde: 860.5,
    });
    blob = addExportRecord(blob, r2);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');
  });
});

// ── Blob-Merge + Normalisierung (Persistenz ohne Migration, §12) ─────────────

describe('exportProtokolle im Blob', () => {
  it('mergeTagesabschlussBlobs vereinigt Protokolle beider Seiten (Union je ID)', () => {
    const base = emptyTagesabschlussBlob();
    const r1: BuchhaltungsExportRecord = {
      id: 'exp-a', monat: MONTH_KEY, version: 1, exportedAt: NOW, exportedBy: 'a@oliv.ch',
      anzahlBuchungen: 10, kassensaldoEnde: 100, fingerprint: 'f1', updatedAt: NOW,
    };
    const r2: BuchhaltungsExportRecord = {
      id: 'exp-b', monat: MONTH_KEY, version: 2, exportedAt: LATER, exportedBy: 'b@oliv.ch',
      anzahlBuchungen: 11, kassensaldoEnde: 120, fingerprint: 'f2', updatedAt: LATER,
    };
    const local = addExportRecord(base, r1);
    const remote = addExportRecord(base, r2);
    const merged = mergeTagesabschlussBlobs(local, remote);
    expect(Object.keys(merged.exportProtokolle).sort()).toEqual(['exp-a', 'exp-b']);
  });

  it('normalizeTagesabschlussBlob übernimmt gültige Records und verwirft Schrott', () => {
    const raw = {
      exportProtokolle: {
        ok: {
          monat: MONTH_KEY, version: 1, exportedAt: NOW, exportedBy: 'a@oliv.ch',
          anzahlBuchungen: 10, kassensaldoEnde: null, fingerprint: 'f1', updatedAt: NOW,
        },
        kaputt1: { version: 1 },            // monat fehlt
        kaputt2: { monat: MONTH_KEY },      // version fehlt
        kaputt3: 'kein Objekt',
      },
    };
    const blob = normalizeTagesabschlussBlob(raw);
    expect(Object.keys(blob.exportProtokolle)).toEqual(['ok']);
    expect(blob.exportProtokolle['ok'].id).toBe('ok');
    expect(blob.exportProtokolle['ok'].kassensaldoEnde).toBeNull();
    // Fehlendes Feld in Alt-Blobs → leeres Objekt, nie undefined.
    expect(normalizeTagesabschlussBlob({}).exportProtokolle).toEqual({});
  });
});

describe('latestRelevantExportMonth', () => {
  it('leerer Blob → null (Cockpit zeigt „nie")', () => {
    expect(latestRelevantExportMonth(emptyTagesabschlussBlob())).toBeNull();
  });

  it('zählt auch Monate, deren EINZIGE Aktivität eine Barausgabe ist (Datum = Schlüssel)', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-08-03', amount: 25, konto: '6000', text: 'Blumen', updatedAt: NOW,
    });
    expect(latestRelevantExportMonth(blob)).toBe('2026-08');
  });

  it('jüngster Monat gewinnt über alle Quellen (Tageswerte vs. Barausgaben)', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 100 }, NOW);
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-09-10', amount: 25, konto: '6000', text: 'Blumen', updatedAt: NOW,
    });
    expect(latestRelevantExportMonth(blob)).toBe('2026-09');
  });
});
