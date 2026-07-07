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
  buildKontrollwerte,
  buildMonatspruefung,
  buildSollHabenVorschau,
  computeMonthFingerprint,
  computeSettingsFingerprint,
  createExportRecord,
  deriveExportStatus,
  exportChecklistOk,
  exportsForMonth,
  kontoLabel,
  latestExportForMonth,
  latestRelevantExportMonth,
  nextExportVersion,
  summarizeBuchungsvorschau,
  VORSCHAU_KATEGORIEN,
} from './buchhaltungs-export';
import { buildTabelle2Rows, type Tabelle2Row } from './tagesabschluss-export';
import {
  buildTagesabschlussRows,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  mergeTagesabschlussBlobs,
  normalizeTagesabschlussBlob,
  setExportSettings,
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
    // Einzahlung Bank (200) ist KEINE Export-Kategorie mehr — keine Gruppe.
    expect(byKat['bank']).toBeUndefined();
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
      sollTotal: 1000, habenTotal: 1000,
    });
    expect(r1.version).toBe(1);
    expect(r1.monat).toBe(MONTH_KEY);
    expect(r1.fingerprint).toBe(computeMonthFingerprint(blob, MONTH_KEY));
    // Historie-Totale + Regeln-Fingerprint werden write-once festgehalten (§7/§9).
    expect(r1.sollTotal).toBe(1000);
    expect(r1.habenTotal).toBe(1000);
    expect(r1.settingsFingerprint).toBe(computeSettingsFingerprint(blob.exportSettings ?? null));
    blob = addExportRecord(blob, r1);

    const r2 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'b@oliv.ch', now: LATER,
      anzahlBuchungen: 13, kassensaldoEnde: 810.5,
      sollTotal: 1042.5, habenTotal: 1042.5,
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
      sollTotal: 1000, habenTotal: 1000,
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
      sollTotal: 1000, habenTotal: 1000,
    });
    blob = addExportRecord(blob, r1);
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 50 }, LATER);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('veraltet');

    const r2 = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: LATER,
      anzahlBuchungen: 13, kassensaldoEnde: 860.5,
      sollTotal: 1050, habenTotal: 1050,
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

  it('Load-Round-Trip erhält sollTotal/habenTotal/settingsFingerprint (Historie + veraltet-Semantik überleben Reload)', () => {
    const record = createExportRecord({
      blob: emptyTagesabschlussBlob(),
      monthKey: MONTH_KEY,
      user: 'a@oliv.ch',
      now: NOW,
      anzahlBuchungen: 12,
      kassensaldoEnde: 350,
      sollTotal: 1042.5,
      habenTotal: 1042.5,
    });
    expect(record.settingsFingerprint).toBeTruthy();
    const blob = addExportRecord(emptyTagesabschlussBlob(), record);
    // Simulierter Persistenz-Round-Trip (localStorage/KV → JSON → normalize beim Laden).
    const reloaded = normalizeTagesabschlussBlob(JSON.parse(JSON.stringify(blob)));
    const r = reloaded.exportProtokolle[record.id];
    expect(r.sollTotal).toBe(1042.5);
    expect(r.habenTotal).toBe(1042.5);
    expect(r.settingsFingerprint).toBe(record.settingsFingerprint);
    // Alt-Record ohne die neuen Felder → null/undefined, kein Crash.
    const legacy = normalizeTagesabschlussBlob({
      exportProtokolle: {
        alt: {
          monat: MONTH_KEY, version: 1, exportedAt: NOW, exportedBy: 'a@oliv.ch',
          anzahlBuchungen: 5, kassensaldoEnde: 10, fingerprint: 'f-alt', updatedAt: NOW,
        },
      },
    });
    expect(legacy.exportProtokolle['alt'].sollTotal).toBeNull();
    expect(legacy.exportProtokolle['alt'].habenTotal).toBeNull();
    expect(legacy.exportProtokolle['alt'].settingsFingerprint).toBeUndefined();
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

// ── Soll/Haben-Buchungsvorschau (§4) ─────────────────────────────────────────

/** Minimaler Tabelle2Row-Bauhelfer für synthetische Randfälle. */
function t2Row(over: Partial<Tabelle2Row> & Pick<Tabelle2Row, 'kategorie' | 'kto' | 'gkto' | 'netto'>): Tabelle2Row {
  return {
    blg: '', datum: '01.07.2026', sh: 'S', grp: '', sid: '', sidx: '', kidx: '',
    btyp: '', mtyp: '', code: '', steuer: 0, fwBetrag: '', tx1: '', tx2: '',
    pkKey: '', opId: '', flag: '',
    ...over,
  };
}

/** Standard-Fixture: 1 Tag mit Bar/MC/VISA/TWINT/Rechnung/Gutschein + 1 Barausgabe. */
function sollHabenFixture(settings: TagesabschlussExportSettings = reviewedSettings()) {
  const closings = { '2026-07-01': makeClosing('2026-07-01') };
  let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
  blob = upsertExpense(blob, {
    id: 'e1', date: '2026-07-01', amount: 42.5, konto: '6000', text: 'Blumen', updatedAt: NOW,
  });
  const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
  const exp = buildTabelle2Rows(rows, closings, blob, settings);
  return { exp, settings };
}

describe('buildSollHabenVorschau', () => {
  it('leitet aus jeder Buchungszeile ZWEI Seiten ab — Soll-Total = Haben-Total', () => {
    const { exp, settings } = sollHabenFixture();
    expect(exp.errors).toEqual([]);
    const sh = buildSollHabenVorschau(exp.rows, settings);

    expect(sh.ausgeglichen).toBe(true);
    expect(sh.differenz).toBe(0);
    expect(sh.sollTotal).toBe(sh.habenTotal);
    expect(sh.anzahlBuchungen).toBe(exp.rows.length);

    // Jede Position hat genau EINE Seite.
    for (const g of sh.gruppen) {
      for (const p of g.positionen) {
        expect(p.soll === null || p.haben === null).toBe(true);
        expect(p.soll !== null || p.haben !== null).toBe(true);
      }
    }

    // Umsatz-Gruppe: Haben-Zeile 1098 „Umsatz" zuerst, Bargeld-Soll danach.
    const umsatz = sh.gruppen.find(g => g.gruppe === 'umsatz')!;
    expect(umsatz.positionen[0].konto).toBe('1098');
    expect(umsatz.positionen[0].bezeichnung).toBe('Umsatz');
    expect(umsatz.positionen[0].haben).toBe(1000); // Brutto-Umsatz aggregiert
    const bar = umsatz.positionen.find(p => p.konto === '1000')!;
    // Barumsatz = 1000 − 550 Karten − 100 TWINT − 30 Rechnung − 20 Gutschein
    expect(bar.soll).toBe(300);

    // Kartenzahlungen: MC+VISA aggregiert auf Sammelkonto 1110, TWINT ebenso.
    const karten = sh.gruppen.find(g => g.gruppe === 'kartenzahlungen')!;
    const sammel = karten.positionen.find(p => p.konto === '1110')!;
    expect(sammel.soll).toBe(650); // 400 + 150 + 100
    expect(sammel.bezeichnung).toBe('KK SIX');

    // Debitoren + eingelöste Gutscheine.
    expect(sh.gruppen.find(g => g.gruppe === 'debitoren')!.soll).toBe(30);
    const gutscheine = sh.gruppen.find(g => g.gruppe === 'gutscheine')!;
    expect(gutscheine.positionen[0].bezeichnung).toBe('Eingelöste Gutscheine');
    expect(gutscheine.positionen[0].soll).toBe(20);
  });

  it('führt Barausgaben EINZELN (Buchungstext), Kassen-Gegenseite aggregiert', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-07-01', amount: 42.5, konto: '6000', text: 'Blumen', updatedAt: NOW,
    });
    blob = upsertExpense(blob, {
      id: 'e2', date: '2026-07-01', amount: 10, konto: '6000', text: 'Briefmarken', updatedAt: NOW,
    });
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const exp = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    const sh = buildSollHabenVorschau(exp.rows, reviewedSettings());

    const be = sh.gruppen.find(g => g.gruppe === 'barausgaben')!;
    const sollZeilen = be.positionen.filter(p => p.soll !== null);
    expect(sollZeilen.map(p => p.bezeichnung).sort()).toEqual(['Blumen', 'Briefmarken']);
    // Gegenseite (Kasse) je Konto aggregiert: EINE Haben-Zeile mit 52.50.
    const habenZeilen = be.positionen.filter(p => p.haben !== null);
    expect(habenZeilen).toHaveLength(1);
    expect(habenZeilen[0].konto).toBe('1000');
    expect(habenZeilen[0].haben).toBe(52.5);
    expect(sh.ausgeglichen).toBe(true);
  });

  it('negativer Betrag tauscht die Seiten (|Betrag|, bleibt ausgeglichen)', () => {
    const sh = buildSollHabenVorschau([
      t2Row({ kategorie: 'barumsatz', kto: '1000', gkto: '1098', netto: -50, tx1: 'Barumsatz' }),
    ], reviewedSettings());
    const umsatz = sh.gruppen.find(g => g.gruppe === 'umsatz')!;
    const kasse = umsatz.positionen.find(p => p.konto === '1000')!;
    const transit = umsatz.positionen.find(p => p.konto === '1098')!;
    expect(kasse.haben).toBe(50); // getauscht: Kasse im Haben
    expect(kasse.soll).toBeNull();
    expect(transit.soll).toBe(50);
    expect(sh.ausgeglichen).toBe(true);
  });

  it('kaputte Zeile (leeres Konto) → Seite entfällt → sichtbare Differenz, nicht ausgeglichen', () => {
    const sh = buildSollHabenVorschau([
      t2Row({ kategorie: 'barumsatz', kto: '', gkto: '1098', netto: 100, tx1: 'Kaputt' }),
    ], reviewedSettings());
    expect(sh.ausgeglichen).toBe(false);
    expect(sh.sollTotal).toBe(0);
    expect(sh.habenTotal).toBe(100);
    expect(sh.differenz).toBe(-100);
  });

  it('Vorschau == Export: Soll-Total = Summe aller |netto| der CSV-Zeilen (§7)', () => {
    const { exp, settings } = sollHabenFixture();
    const sh = buildSollHabenVorschau(exp.rows, settings);
    const csvSumme = Math.round(exp.rows.reduce((s, r) => s + Math.abs(r.netto), 0) * 100) / 100;
    expect(sh.sollTotal).toBe(csvSumme);
    expect(sh.habenTotal).toBe(csvSumme);
    expect(sh.anzahlBuchungen).toBe(exp.rows.length);
  });

  it('Regeländerung (Konto je Zahlungsart) verschiebt die Position aufs neue Konto', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 1, amount: 900 },
          { name: 'Amex', count: 1, amount: 100 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});

    const s1 = reviewedSettings();
    const exp1 = buildTabelle2Rows(rows, closings, blob, s1);
    const sh1 = buildSollHabenVorschau(exp1.rows, s1);
    expect(sh1.gruppen.find(g => g.gruppe === 'kartenzahlungen')!.positionen[0].konto).toBe('1114');

    const s2 = reviewedSettings({
      kontoJeZahlungsart: { ...s1.kontoJeZahlungsart, amex: '1999' },
    });
    const exp2 = buildTabelle2Rows(rows, closings, blob, s2);
    const sh2 = buildSollHabenVorschau(exp2.rows, s2);
    const pos2 = sh2.gruppen.find(g => g.gruppe === 'kartenzahlungen')!.positionen[0];
    expect(pos2.konto).toBe('1999');
    expect(pos2.bezeichnung).toBe('Konto 1999'); // keine Bezeichnung hinterlegt
    expect(sh2.ausgeglichen).toBe(true);
  });
});

describe('kontoLabel', () => {
  it('bevorzugt kontoBezeichnungen, fällt auf Default-Katalog bzw. «Konto NNNN» zurück', () => {
    const s = reviewedSettings({ kontoBezeichnungen: { '1110': 'SIX Karten' } });
    expect(kontoLabel(s, '1110')).toBe('SIX Karten');
    expect(kontoLabel(s, '1098')).toBe('Umsatz');          // Default-Katalog
    expect(kontoLabel(s, '9999')).toBe('Konto 9999');      // unbekannt
    expect(kontoLabel(null, '1000')).toBe('Bargeld');      // null-Settings
  });
});

// ── Kontrollwerte (§5) ───────────────────────────────────────────────────────

describe('buildKontrollwerte', () => {
  it('liefert Einzahlung Bank + Salden — und diese erscheinen NIE als Buchungsposition', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 200 }, NOW);
    blob = { ...blob, anfangsbestand: { '2026-07': { value: 500, updatedAt: NOW } } };
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, undefined, 500);
    const kw = Object.fromEntries(buildKontrollwerte(month).map(k => [k.key, k.value]));
    expect(kw['einzahlung_bank']).toBe(200);
    expect(kw['saldo_anfang']).toBe(500);
    expect(kw['saldo_ende']).not.toBeNull();

    // Bank-Konto (1020) taucht in KEINER Soll/Haben-Position auf.
    const exp = buildTabelle2Rows(month.rows, closings, blob, reviewedSettings());
    const sh = buildSollHabenVorschau(exp.rows, reviewedSettings());
    const alleKonten = sh.gruppen.flatMap(g => g.positionen.map(p => p.konto));
    expect(alleKonten).not.toContain('1020');
  });
});

// ── Settings-Fingerprint (§9: „veraltet" bei Regeländerung) ──────────────────

describe('computeSettingsFingerprint + deriveExportStatus', () => {
  it('identisches Re-Speichern (nur updatedAt/reviewed) ändert den Fingerprint NICHT', () => {
    const a = reviewedSettings();
    const b = { ...reviewedSettings(), updatedAt: LATER, reviewed: false };
    expect(computeSettingsFingerprint(a)).toBe(computeSettingsFingerprint(b));
  });

  it('Konto-Änderung ändert den Fingerprint; Legacy-Felder + Bezeichnungen nicht', () => {
    const base = reviewedSettings();
    const fp = computeSettingsFingerprint(base);
    expect(computeSettingsFingerprint(reviewedSettings({
      konten: { ...base.konten, kasse: '1005' },
    }))).not.toBe(fp);
    expect(computeSettingsFingerprint(reviewedSettings({
      kontoJeZahlungsart: { ...base.kontoJeZahlungsart, amex: '1999' },
    }))).not.toBe(fp);
    expect(computeSettingsFingerprint(reviewedSettings({ blgStart: '5001' }))).not.toBe(fp);
    // Anzeige-/Legacy-Felder sind bewusst NICHT export-relevant.
    expect(computeSettingsFingerprint(reviewedSettings({
      kontoBezeichnungen: { '1110': 'Umbenannt' },
    }))).toBe(fp);
    expect(computeSettingsFingerprint(reviewedSettings({
      konten: { ...base.konten, bank: '1021', umsatz: '3999' },
      mwstCodes: { '8.1': 'U81' },
    }))).toBe(fp);
    // null == Default-Settings (gleiche Basis wie die Vorschau).
    expect(computeSettingsFingerprint(null))
      .toBe(computeSettingsFingerprint(defaultExportSettings(NOW)));
  });

  it('Regeländerung nach dem Export → Status „veraltet"; Re-Save ohne Änderung nicht', () => {
    let blob = withClosedDays(withClosedMonth(emptyTagesabschlussBlob(), MONTH_KEY), ['2026-07-01']);
    blob = setExportSettings(blob, reviewedSettings());
    const rec = createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'a@oliv.ch', now: NOW,
      anzahlBuchungen: 12, kassensaldoEnde: 810.5, sollTotal: 1000, habenTotal: 1000,
    });
    blob = addExportRecord(blob, rec);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');

    // Re-Save ohne inhaltliche Änderung (nur updatedAt) → bleibt exportiert.
    blob = setExportSettings(blob, { ...reviewedSettings(), updatedAt: LATER });
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');

    // Export-relevante Regeländerung → veraltet (§9).
    const geaendert = reviewedSettings();
    blob = setExportSettings(blob, {
      ...geaendert,
      konten: { ...geaendert.konten, kartenSammel: '1111' },
      updatedAt: LATER,
    });
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('veraltet');
  });

  it('Alt-Record OHNE settingsFingerprint kippt bei Regeländerung NICHT auf veraltet', () => {
    let blob = withClosedDays(withClosedMonth(emptyTagesabschlussBlob(), MONTH_KEY), ['2026-07-01']);
    blob = setExportSettings(blob, reviewedSettings());
    const legacy: BuchhaltungsExportRecord = {
      id: 'exp-legacy', monat: MONTH_KEY, version: 1, exportedAt: NOW, exportedBy: 'a@oliv.ch',
      anzahlBuchungen: 10, kassensaldoEnde: 100,
      fingerprint: computeMonthFingerprint(blob, MONTH_KEY), updatedAt: NOW,
    };
    blob = addExportRecord(blob, legacy);
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');

    const geaendert = reviewedSettings();
    blob = setExportSettings(blob, {
      ...geaendert,
      konten: { ...geaendert.konten, kasse: '1005' },
      updatedAt: LATER,
    });
    // Datenstand unverändert, Alt-Record ohne Regeln-Fingerprint → KEIN Flip.
    expect(deriveExportStatus(blob, MONTH_KEY)).toBe('exportiert');
  });
});
