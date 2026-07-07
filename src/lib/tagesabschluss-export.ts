/**
 * Tagesabschluss → Buchhaltungs-Export (Tabelle2) — REINE Logik
 * =============================================================================
 * Erzeugt aus den Tagesabschluss-Zeilen Buchungssätze im 20-Spalten-Format der
 * Excel-Datei "UMSATZ Oliv" / Sheet "Tabelle2" (Sage-50-artiger Buchungsimport):
 * Blg;Datum;Kto;S/H;Grp;GKto;SId;SIdx;KIdx;BTyp;MTyp;Code;Netto;Steuer;
 * FW-Betrag;Tx1;Tx2;PkKey;OpId;Flag
 *
 * Buchungsmodell (über das Umsatz-Durchlaufkonto, z. B. 1098 "DLK Umsatz"):
 *  - Umsatz GESAMMELT pro Tag: je Steuersatz eine Zeile
 *      Kto = umsatzTransit / GKto = umsatz, Netto + Steuer + MWST-Code.
 *  - Zahlungsmittel-Seite pro Tag: je Kanal eine Zeile, Kto = Kanal-Konto /
 *      GKto = umsatzTransit, Betrag brutto:
 *      Barumsatz (BERECHNET aus Tageswerten), Karten je Zahlungsart (oder
 *      Sammelkonto), TWINT, Rechnung/Debitoren, eingelöste Gutscheine.
 *  - Verkaufte Gutscheine separat: Kto = kasse / GKto = gutscheine.
 *  - Einzahlung Bank: Kto = bank / GKto = kasse.
 *  - Barausgaben EINZELN (nie nur als Total): Kto = Ausgabe-Konto /
 *      GKto = Gegenkonto oder kasse, Text/Beleg/MWST-Code aus der Erfassung.
 *
 * Kein Export ohne vollständiges, GEPRÜFTES Konto-Mapping (`reviewed`) —
 * es werden NIE Platzhalter-Konten emittiert.
 *
 * KORREKTUREN (Overrides) UND EXPORT: Der Export verwendet durchgängig die
 * ORIGINAL-Z-Bericht-Werte (DayCell.auto) — nie die korrigierten Effektivwerte.
 * Grund: Umsatz-Zeilen (je Steuersatz) und Karten-Zeilen (je Zahlungsart)
 * stammen zwingend aus den Original-Detaildaten; eine Korrektur der SUMME
 * liesse sich nicht verteilen und würde das Durchlaufkonto aus der Balance
 * bringen. Korrekturen gelten der Übersicht/Kassenkontrolle; betroffene Tage
 * werden beim Export EXPLIZIT als Warnung gelistet (manuell nachbuchen).
 */

import { type ExportTable, buildCsvWithBom } from './export-cell';
import {
  TAGESABSCHLUSS_AUTO_FIELDS,
  TAGESABSCHLUSS_FIELD_LABEL,
  type TagesabschlussRow,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
  type GnDayClosing,
  type CashExpense,
} from './tagesabschluss';
import { normalizeGnPaymentName } from './adyen-abstimmung';

// ── Zeilenmodell ─────────────────────────────────────────────────────────────

export const TABELLE2_HEADERS = [
  'Blg', 'Datum', 'Kto', 'S/H', 'Grp', 'GKto', 'SId', 'SIdx', 'KIdx',
  'BTyp', 'MTyp', 'Code', 'Netto', 'Steuer', 'FW-Betrag', 'Tx1', 'Tx2',
  'PkKey', 'OpId', 'Flag',
] as const;

/**
 * Fachliche Kategorie einer Buchungszeile — NUR für die Buchungsvorschau
 * (Gruppierung); wird NICHT ins CSV exportiert. Strukturell beim Erzeugen
 * gesetzt (robust — keine Rückwärts-Klassifikation über Kontonummern/Texte).
 */
export type Tabelle2Kategorie =
  | 'umsatz'
  | 'barumsatz'
  | 'kreditkarten'
  | 'twint'
  | 'debitoren'
  | 'gutschein_verkauft'
  | 'gutschein_eingeloest'
  | 'bank'
  | 'barausgabe';

export interface Tabelle2Row {
  /** Vorschau-Kategorie (nicht Teil des CSV). */
  kategorie: Tabelle2Kategorie;
  blg: string;
  datum: string; // dd.MM.yyyy
  kto: string;
  sh: 'S' | 'H' | '';
  grp: string;
  gkto: string;
  sid: string;
  sidx: string;
  kidx: string;
  btyp: string;
  mtyp: string;
  code: string;
  netto: number;
  steuer: number;
  fwBetrag: string;
  tx1: string;
  tx2: string;
  pkKey: string;
  opId: string;
  flag: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** yyyy-MM-dd → dd.MM.yyyy (rein textuell, kein Date-Parsing). */
export function isoToChDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function makeRow(
  partial: Partial<Tabelle2Row> & Pick<Tabelle2Row, 'kategorie' | 'datum' | 'kto' | 'gkto' | 'netto'>,
): Tabelle2Row {
  return {
    blg: '', sh: 'S', grp: '', sid: '', sidx: '', kidx: '', btyp: '', mtyp: '',
    code: '', steuer: 0, fwBetrag: '', tx1: '', tx2: '', pkKey: '', opId: '', flag: '',
    ...partial,
  };
}

// ── Validierung ──────────────────────────────────────────────────────────────

export interface ExportValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Prüft, ob mit den Einstellungen exportiert werden darf. Fehlende Konten und
 * fehlende MWST-Codes werden EXPLIZIT aufgelistet — kein stiller Fallback.
 */
export function validateExportSettings(
  settings: TagesabschlussExportSettings | null,
  rows: readonly TagesabschlussRow[],
  closings: Record<string, GnDayClosing>,
): ExportValidation {
  const errors: string[] = [];
  if (!settings) {
    return { ok: false, errors: ['Export-Einstellungen sind noch nicht konfiguriert.'] };
  }

  const roleLabels: Record<keyof TagesabschlussExportSettings['konten'], string> = {
    kasse: 'Kasse', bank: 'Bank', debitoren: 'Debitoren', gutscheine: 'Gutscheine',
    kartenSammel: 'Kreditkarten-Sammelkonto', umsatz: 'Umsatz', umsatzTransit: 'Umsatz-Durchlaufkonto',
  };
  for (const [role, label] of Object.entries(roleLabels) as Array<[keyof typeof roleLabels, string]>) {
    if (!settings.konten[role] || settings.konten[role].trim() === '') {
      errors.push(`Konto fehlt: ${label}`);
    }
  }

  // Jeder im Monat vorkommende Steuersatz braucht einen MWST-Code.
  const rates = new Set<string>();
  for (const row of rows) {
    if (!row.hasZbericht) continue;
    for (const t of closings[row.date]?.taxes ?? []) {
      if (t.rate.trim() !== '') rates.add(t.rate.trim());
    }
  }
  for (const rate of [...rates].sort()) {
    if (!settings.mwstCodes[rate] || settings.mwstCodes[rate].trim() === '') {
      errors.push(`MWST-Code fehlt für Steuersatz "${rate}"`);
    }
  }

  if (!settings.reviewed) {
    errors.push('Konto-Mapping wurde noch nicht als geprüft markiert.');
  }
  return { ok: errors.length === 0, errors };
}

/** Prüft die Barausgaben eines Monats auf fehlende Pflichtfelder. */
export function validateExpenses(expenses: readonly CashExpense[]): string[] {
  const errors: string[] = [];
  for (const e of expenses) {
    if (!e.konto || e.konto.trim() === '') {
      errors.push(`Barausgabe ${isoToChDate(e.date)} "${e.text || e.id}": Konto fehlt`);
    }
    if (!Number.isFinite(e.amount) || e.amount === 0) {
      errors.push(`Barausgabe ${isoToChDate(e.date)} "${e.text || e.id}": Betrag fehlt oder 0`);
    }
  }
  return errors;
}

// ── Buchungssätze ────────────────────────────────────────────────────────────

export interface Tabelle2Export {
  rows: Tabelle2Row[];
  errors: string[];
  /**
   * Nicht-blockierende Hinweise: Korrekturen (Overrides) auf Auto-Feldern
   * sind NICHT im Export enthalten (Export = Original-Z-Bericht) und müssen
   * manuell nachgebucht werden.
   */
  warnings: string[];
}

/**
 * Listet alle Korrekturen (Overrides) auf export-relevanten Auto-Feldern —
 * der Export verwendet die Originale, diese Abweichungen sind manuell zu buchen.
 */
export function collectExportOverrideWarnings(rows: readonly TagesabschlussRow[]): string[] {
  const warnings: string[] = [];
  for (const row of rows) {
    for (const f of TAGESABSCHLUSS_AUTO_FIELDS) {
      if (f === 'trinkgeld') continue; // wird nicht exportiert
      const cell = row.cells[f];
      if (cell.source !== 'corrected' || !cell.override) continue;
      const orig = cell.override.originalValue;
      const corr = cell.override.correctedValue;
      warnings.push(
        `Korrektur ${isoToChDate(row.date)} „${TAGESABSCHLUSS_FIELD_LABEL[f]}" ` +
        `(${orig.toFixed(2)} → ${corr === null ? '—' : corr.toFixed(2)}): ` +
        'Der Export verwendet die ORIGINAL-Z-Bericht-Werte — Differenz manuell nachbuchen.',
      );
    }
  }
  return warnings;
}

/**
 * Buchhaltungs-Export NUR aus abgeschlossenen Tagesabschlüssen: jeder Tag mit
 * Z-Bericht muss definitiv abgeschlossen sein (status abgeschlossen /
 * abgeschlossen_mit_differenz), sonst BLOCKIERT der Export mit klarer
 * Fehlerliste — nie ein stiller Teil-Export nicht bestätigter Tage.
 */
export function collectUnclosedDayErrors(rows: readonly TagesabschlussRow[]): string[] {
  const unclosed = rows.filter(r => r.hasZbericht && !r.locked);
  if (unclosed.length === 0) return [];
  const list = unclosed.map(r => isoToChDate(r.date)).join(', ');
  return [
    `Export nur aus abgeschlossenen Tagen möglich — ${unclosed.length} Tag(e) ` +
    `nicht abgeschlossen: ${list}. Bitte zuerst jeden Tag definitiv abschließen.`,
  ];
}

/**
 * Erzeugt die Tabelle2-Buchungszeilen eines Monats.
 * Liefert bei unvollständigem Mapping KEINE Zeilen, sondern Fehler.
 * Beträge stammen IMMER aus den Original-Z-Bericht-Werten (DayCell.auto) —
 * Korrekturen werden als `warnings` ausgewiesen (s. Kopfkommentar).
 * BLOCKIERT, solange nicht alle Z-Bericht-Tage abgeschlossen sind (§10).
 */
export function buildTabelle2Rows(
  rows: readonly TagesabschlussRow[],
  closings: Record<string, GnDayClosing>,
  blob: TagesabschlussBlob,
  settings: TagesabschlussExportSettings | null,
): Tabelle2Export {
  const monthExpenses = rows.flatMap(r => blob.expenses[r.date] ?? []);
  const validation = validateExportSettings(settings, rows, closings);
  const expenseErrors = validateExpenses(monthExpenses);
  const closureErrors = collectUnclosedDayErrors(rows);
  const errors = [...validation.errors, ...expenseErrors, ...closureErrors];
  const warnings = collectExportOverrideWarnings(rows);
  if (errors.length > 0 || !settings) return { rows: [], errors, warnings };

  const k = settings.konten;
  const out: Tabelle2Row[] = [];
  let blgCounter = settings.blgStart && /^\d+$/.test(settings.blgStart.trim())
    ? parseInt(settings.blgStart.trim(), 10)
    : null;
  const nextBlg = (): string => {
    if (blgCounter === null) return '';
    return String(blgCounter++);
  };

  for (const row of rows) {
    const date = isoToChDate(row.date);
    const closing = closings[row.date];

    if (row.hasZbericht && closing && (row.cells.umsatz.auto ?? 0) !== 0) {
      // 1) Umsatz GESAMMELT pro Tag: je Steuersatz eine Zeile (Netto + Steuer).
      const blg = nextBlg();
      for (const t of closing.taxes) {
        out.push(makeRow({
          kategorie: 'umsatz',
          blg, datum: date, kto: k.umsatzTransit, gkto: k.umsatz,
          code: settings.mwstCodes[t.rate.trim()] ?? '',
          netto: round2(t.net), steuer: round2(t.tax),
          tx1: `Tagesumsatz ${date}`,
        }));
      }
      // Ohne Steuerbericht: eine Bruttozeile ohne Code (sichtbar, kein Verlust).
      if (closing.taxes.length === 0) {
        out.push(makeRow({
          kategorie: 'umsatz',
          blg, datum: date, kto: k.umsatzTransit, gkto: k.umsatz,
          netto: round2(row.cells.umsatz.auto ?? 0),
          tx1: `Tagesumsatz ${date} (ohne Steuerbericht)`,
        }));
      }

      // 2) Zahlungsmittel-Seite: Barumsatz — aus ORIGINAL-Werten berechnet,
      // damit die Zahlungsmittel-Seite exakt den Original-Umsatz deckt
      // (row.barumsatz nutzt Effektivwerte und würde bei Korrekturen das
      // Durchlaufkonto aus der Balance bringen).
      const exportBarumsatz = round2(
        (row.cells.umsatz.auto ?? 0)
        - (row.cells.karten.auto ?? 0)
        - (row.cells.twint.auto ?? 0)
        - (row.cells.rechnung.auto ?? 0)
        - (row.cells.gutscheinEingeloest.auto ?? 0),
      );
      if (exportBarumsatz !== 0) {
        out.push(makeRow({
          kategorie: 'barumsatz',
          blg: nextBlg(), datum: date, kto: k.kasse, gkto: k.umsatzTransit,
          netto: exportBarumsatz, tx1: `Barumsatz ${date}`,
        }));
      }

      // 3) Karten/TWINT je Zahlungsart (oder Sammelkonto).
      const cardAmounts = new Map<string, { label: string; amount: number }>();
      for (const pm of closing.payments) {
        const norm = normalizeGnPaymentName(pm.name);
        if (!norm.isCard) continue;
        const prev = cardAmounts.get(norm.key);
        cardAmounts.set(norm.key, { label: norm.label, amount: (prev?.amount ?? 0) + pm.amount });
      }
      // Korrektur-Overrides auf Karten/TWINT-SUMMEN proportional NICHT verteilen —
      // Overrides gelten der Übersicht; Export nutzt die Original-Zahlarten.
      for (const [key, { label, amount }] of [...cardAmounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (round2(amount) === 0) continue;
        const konto = settings.kontoJeZahlungsart[key]?.trim() || k.kartenSammel;
        out.push(makeRow({
          kategorie: key === 'twint' ? 'twint' : 'kreditkarten',
          blg: nextBlg(), datum: date, kto: konto, gkto: k.umsatzTransit,
          netto: round2(amount), tx1: `${label} ${date}`,
        }));
      }

      // 4) Rechnung/Debitoren separat.
      if ((row.cells.rechnung.auto ?? 0) !== 0) {
        out.push(makeRow({
          kategorie: 'debitoren',
          blg: nextBlg(), datum: date, kto: k.debitoren, gkto: k.umsatzTransit,
          netto: round2(row.cells.rechnung.auto ?? 0), tx1: `Rechnung/Debitoren ${date}`,
        }));
      }

      // 5) Gutscheine: eingelöst (Zahlungsmittel) und verkauft (separat).
      if ((row.cells.gutscheinEingeloest.auto ?? 0) !== 0) {
        out.push(makeRow({
          kategorie: 'gutschein_eingeloest',
          blg: nextBlg(), datum: date, kto: k.gutscheine, gkto: k.umsatzTransit,
          netto: round2(row.cells.gutscheinEingeloest.auto ?? 0), tx1: `Gutscheine eingelöst ${date}`,
        }));
      }
    }

    if ((row.cells.gutscheinVerkauft.auto ?? 0) !== 0) {
      out.push(makeRow({
        kategorie: 'gutschein_verkauft',
        blg: nextBlg(), datum: date, kto: k.kasse, gkto: k.gutscheine,
        netto: round2(row.cells.gutscheinVerkauft.auto ?? 0), tx1: `Gutscheine verkauft ${date}`,
      }));
    }

    // 6) Einzahlung Bank (manuell erfasst).
    if ((row.cells.einzahlungBank.value ?? 0) !== 0) {
      out.push(makeRow({
        kategorie: 'bank',
        blg: nextBlg(), datum: date, kto: k.bank, gkto: k.kasse,
        netto: round2(row.cells.einzahlungBank.value ?? 0), tx1: `Einzahlung Bank ${date}`,
      }));
    }

    // 7) Barausgaben EINZELN — nie nur als Total.
    for (const e of blob.expenses[row.date] ?? []) {
      out.push(makeRow({
        kategorie: 'barausgabe',
        blg: e.belegNr?.trim() || nextBlg(),
        datum: isoToChDate(e.date),
        kto: e.konto.trim(),
        gkto: e.gegenkonto?.trim() || k.kasse,
        code: e.mwstCode?.trim() ?? '',
        netto: round2(e.amount),
        tx1: e.text.trim(),
        tx2: e.kommentar?.trim() ?? '',
      }));
    }
  }

  return { rows: out, errors: [], warnings };
}

// ── CSV-Serialisierung ───────────────────────────────────────────────────────

/** Betrag im Buchungsformat: 2 Nachkommastellen, Punkt-Dezimal. */
export function formatBookingAmount(v: number): string {
  return v.toFixed(2);
}

export function tabelle2ToExportTable(rows: readonly Tabelle2Row[], filename: string): ExportTable {
  return {
    filename,
    headers: [...TABELLE2_HEADERS],
    rows: rows.map(r => [
      r.blg, r.datum, r.kto, r.sh, r.grp, r.gkto, r.sid, r.sidx, r.kidx,
      r.btyp, r.mtyp, r.code,
      formatBookingAmount(r.netto),
      r.steuer !== 0 ? formatBookingAmount(r.steuer) : '',
      r.fwBetrag, r.tx1, r.tx2, r.pkKey, r.opId, r.flag,
    ]),
  };
}

/** Komplettes CSV (UTF-8 BOM, Semikolon, CRLF) für den Download. */
export function buildTabelle2Csv(rows: readonly Tabelle2Row[], filename: string): string {
  return buildCsvWithBom(tabelle2ToExportTable(rows, filename));
}
