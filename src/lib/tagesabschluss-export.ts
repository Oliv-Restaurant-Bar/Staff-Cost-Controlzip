/**
 * Tagesabschluss → Buchhaltungs-Export (Tabelle2) — REINE Logik
 * =============================================================================
 * Erzeugt aus den Tagesabschluss-Zeilen Buchungssätze im 20-Spalten-Format der
 * Excel-Datei "UMSATZ Oliv" / Sheet "Tabelle2" (Sage-50-artiger Buchungsimport):
 * Blg;Datum;Kto;S/H;Grp;GKto;SId;SIdx;KIdx;BTyp;MTyp;Code;Netto;Steuer;
 * FW-Betrag;Tx1;Tx2;PkKey;OpId;Flag
 *
 * Buchungsmodell (BRUTTO, ohne MWST — Spec „Buchhaltungs-Export final"):
 *  - KEINE MWST-Buchung: kein Konto 2200, keine Steuer-Spalte, keine
 *    Umsatz-je-Steuersatz-Zeilen. Der Bruttoumsatz landet direkt auf dem
 *    Umsatz-Brutto-Konto (konten.umsatzTransit, z. B. 1098) — als
 *    HABEN-Seite (GKto) JEDER Zahlweg-Zeile; eine separate Umsatz-Sammel-
 *    zeile ist nicht nötig (jede Zeile ist ein vollständiger Buchungssatz).
 *  - Zahlungsmittel-Seite pro Tag, je Kanal eine Zeile (Kto = Kanal, Soll):
 *      Barumsatz (BERECHNET, Residual) → kasse (1000),
 *      Karten je Zahlungsart oder Sammelkonto (KK/SIX/MC/Visa/TWINT → 1110,
 *      AMEX 1114, PostCard 1116, Lunch-Check/Just Eat 1115, Stripe 1118),
 *      Rechnung/Debitoren → debitoren (1100),
 *      UNKLASSIFIZIERTE Zahlarten (z. B. KD Tisch 5000 → 1104) SEPARAT —
 *      ohne Konto-Mapping blockiert der Export (kein stiller Barumsatz-Rest),
 *      eingelöste Gutscheine → gutscheine (2003, Soll).
 *  - Verkaufte Gutscheine separat: Kto = kasse / GKto = gutscheine (2003 Haben).
 *  - Einzahlung Bank wird NICHT exportiert: sie dient nur dem fortlaufenden
 *      Kassensaldo; die echte Bankbuchung erfolgt separat über den Bankbeleg/
 *      Bankimport (sonst Doppelbuchung).
 *  - Barausgaben EINZELN (nie nur als Total): Kto = Ausgabe-Konto /
 *      GKto = Gegenkonto oder kasse, Text/Beleg aus der Erfassung; der
 *      MWST-Code der AUSGABE (Vorsteuer) bleibt erhalten — das MWST-Verbot
 *      gilt der Umsatzseite.
 *  - Balance je Tag: Σ(Zeilen mit GKto = Umsatz brutto) = Original-Umsatz.
 *  - Es werden NIE Nullzeilen emittiert (nur Zeilen mit Betrag ≠ 0).
 *
 * Kein Export ohne vollständiges, GEPRÜFTES Konto-Mapping (`reviewed`) —
 * es werden NIE Platzhalter-Konten emittiert.
 *
 * KORREKTUREN (Overrides) UND EXPORT: Der Export verwendet die EFFEKTIVEN
 * Werte (DayCell.value — Override > manuell > auto). Karten-/TWINT-Einzelart-
 * Zeilen stammen weiterhin aus den Original-Zahlarten des Z-Berichts (eine
 * Summen-Korrektur lässt sich nicht auf Einzelarten verteilen); die Differenz
 * eines karten-/twint-Overrides wird als EIGENE Korrektur-Zeile auf das
 * jeweilige Konto (KK-Sammel bzw. TWINT-Konto) gebucht. Das Barumsatz-Residual
 * rechnet aus Effektivwerten — die Tages-Balance Σ Zahlwege = Umsatz brutto
 * (effektiv) bleibt strukturell garantiert. Enthaltene Korrekturen werden als
 * nicht-blockierende Hinweise (`warnings`) gelistet (Transparenz, kein Blocker).
 */

import { type ExportTable, buildCsvWithBom } from './export-cell';
import {
  TAGESABSCHLUSS_AUTO_FIELDS,
  TAGESABSCHLUSS_FIELD_LABEL,
  collectUnclassifiedZahlarten,
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
  | 'barumsatz'
  | 'kreditkarten'
  | 'twint'
  | 'debitoren'
  | 'weitere_zahlungsarten'
  | 'gutschein_verkauft'
  | 'gutschein_eingeloest'
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
 * Rollen-Konten, die das Brutto-Modell tatsächlich bebucht — `umsatz` (altes
 * Ertragskonto), `mwstCodes` und `bank` sind LEGACY und werden bewusst NICHT
 * mehr validiert (keine MWST-Buchungen mehr; Einzahlung Bank wird nicht
 * exportiert und darf deshalb nie als fehlendes Mapping blockieren).
 */
const REQUIRED_KONTO_ROLES: ReadonlyArray<[keyof TagesabschlussExportSettings['konten'], string]> = [
  ['kasse', 'Kasse'],
  ['debitoren', 'Debitoren'],
  ['gutscheine', 'Gutscheine'],
  ['kartenSammel', 'Kreditkarten-Sammelkonto'],
  ['umsatzTransit', 'Umsatz brutto'],
];

/**
 * Prüft, ob mit den Einstellungen exportiert werden darf. Fehlende Konten
 * werden EXPLIZIT aufgelistet — kein stiller Fallback. Unklassifizierte
 * Zahlarten (z. B. KD Tisch 5000) brauchen zwingend ein eigenes Konto im
 * Zahlungsarten-Mapping, sonst blockiert der Export (sie würden sonst
 * stillschweigend im Barumsatz landen).
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

  for (const [role, label] of REQUIRED_KONTO_ROLES) {
    if (!settings.konten[role] || settings.konten[role].trim() === '') {
      errors.push(`Konto fehlt: ${label}`);
    }
  }

  // Jede unklassifizierte Zahlart des Monats braucht ein eigenes Konto.
  const unmapped = new Map<string, string>();
  for (const row of rows) {
    if (!row.hasZbericht) continue;
    for (const z of collectUnclassifiedZahlarten(closings[row.date])) {
      if (round2(z.amount) === 0) continue;
      if (!settings.kontoJeZahlungsart[z.key]?.trim()) unmapped.set(z.key, z.label);
    }
  }
  for (const [, label] of [...unmapped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    errors.push(
      `Konto fehlt für Zahlungsart "${label}" — unklassifizierte Zahlarten müssen ` +
      'im Konto-Mapping (Konto je Zahlungsart) einzeln kontiert werden.',
    );
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
   * SIND im Export enthalten (Export = Effektivwerte) — die Liste dient der
   * Transparenz (welcher Tag/welches Feld wurde manuell übersteuert).
   */
  warnings: string[];
}

/**
 * Listet alle Korrekturen (Overrides) auf export-relevanten Auto-Feldern —
 * der Export verwendet die Effektivwerte; diese Liste macht die enthaltenen
 * manuellen Übersteuerungen sichtbar (Info, kein Blocker).
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
        'Der Export verwendet diesen manuell übersteuerten Ist-Wert.',
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
 * Beträge stammen aus den EFFEKTIVEN Werten (DayCell.value, Override >
 * manuell > auto); karten-/twint-Overrides werden als eigene Korrektur-Zeile
 * gebucht. Enthaltene Korrekturen werden als `warnings` (Info) ausgewiesen
 * (s. Kopfkommentar). BLOCKIERT, solange nicht alle Z-Bericht-Tage
 * abgeschlossen sind (§10).
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

    if (row.hasZbericht && closing && (row.cells.umsatz.value ?? 0) !== 0) {
      // BRUTTO-Modell: KEINE Umsatz-/MWST-Zeilen — der Bruttoumsatz entsteht
      // als Haben (GKto = Umsatz brutto) auf JEDER Zahlweg-Zeile unten.

      // Unklassifizierte Zahlarten (z. B. KD Tisch 5000) werden SEPARAT
      // gebucht (Mapping in der Validierung erzwungen) und deshalb hier
      // zusätzlich vom Barumsatz-Residual abgezogen.
      const unclassified = collectUnclassifiedZahlarten(closing)
        .filter(z => round2(z.amount) !== 0);
      const unclassifiedSum = round2(unclassified.reduce((s, z) => s + z.amount, 0));

      // 1) Zahlungsmittel-Seite: Barumsatz — Residual aus EFFEKTIVwerten
      // (Override > manuell > auto), damit die Zahlungsmittel-Seite exakt den
      // effektiven Tagesumsatz deckt (Balance: Σ Zahlwege = Umsatz effektiv;
      // Karten-/TWINT-Overrides gehen unten als Korrektur-Zeile ein).
      const exportBarumsatz = round2(
        (row.cells.umsatz.value ?? 0)
        - (row.cells.karten.value ?? 0)
        - (row.cells.twint.value ?? 0)
        - (row.cells.rechnung.value ?? 0)
        - (row.cells.gutscheinEingeloest.value ?? 0)
        - unclassifiedSum,
      );
      if (exportBarumsatz !== 0) {
        out.push(makeRow({
          kategorie: 'barumsatz',
          blg: nextBlg(), datum: date, kto: k.kasse, gkto: k.umsatzTransit,
          netto: exportBarumsatz, tx1: `Barumsatz ${date}`,
        }));
      }

      // 2) Karten/TWINT je Zahlungsart (oder Sammelkonto). isKkCard umfasst
      // auch kartenähnliche Zahlarten ohne Adyen-Abwicklung (PostCard/
      // Lunch-Check/Stripe) — sie werden hier SEPARAT gebucht und stecken
      // spiegelbildlich im karten.auto-Abzug des Barumsatzes (Balance).
      const cardAmounts = new Map<string, { label: string; amount: number }>();
      for (const pm of closing.payments) {
        const norm = normalizeGnPaymentName(pm.name);
        if (!norm.isKkCard) continue;
        const prev = cardAmounts.get(norm.key);
        cardAmounts.set(norm.key, { label: norm.label, amount: (prev?.amount ?? 0) + pm.amount });
      }
      // Einzelart-Zeilen stammen IMMER aus den Original-Zahlarten (eine
      // Summen-Korrektur lässt sich nicht auf Einzelarten verteilen).
      for (const [key, { label, amount }] of [...cardAmounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (round2(amount) === 0) continue;
        const konto = settings.kontoJeZahlungsart[key]?.trim() || k.kartenSammel;
        out.push(makeRow({
          kategorie: key === 'twint' ? 'twint' : 'kreditkarten',
          blg: nextBlg(), datum: date, kto: konto, gkto: k.umsatzTransit,
          netto: round2(amount), tx1: `${label} ${date}`,
        }));
      }
      // Karten-/TWINT-Override: Differenz (effektiv − Original) als EIGENE
      // Korrektur-Zeile — Einzelarten bleiben original, Balance bleibt exakt.
      const kartenDelta = round2((row.cells.karten.value ?? 0) - (row.cells.karten.auto ?? 0));
      if (kartenDelta !== 0) {
        out.push(makeRow({
          kategorie: 'kreditkarten',
          blg: nextBlg(), datum: date, kto: k.kartenSammel, gkto: k.umsatzTransit,
          netto: kartenDelta, tx1: `KK Korrektur (manuell) ${date}`,
        }));
      }
      const twintDelta = round2((row.cells.twint.value ?? 0) - (row.cells.twint.auto ?? 0));
      if (twintDelta !== 0) {
        out.push(makeRow({
          kategorie: 'twint',
          blg: nextBlg(), datum: date,
          kto: settings.kontoJeZahlungsart['twint']?.trim() || k.kartenSammel,
          gkto: k.umsatzTransit,
          netto: twintDelta, tx1: `TWINT Korrektur (manuell) ${date}`,
        }));
      }

      // 3) Rechnung/Debitoren separat (Effektivwert inkl. Korrektur).
      if ((row.cells.rechnung.value ?? 0) !== 0) {
        out.push(makeRow({
          kategorie: 'debitoren',
          blg: nextBlg(), datum: date, kto: k.debitoren, gkto: k.umsatzTransit,
          netto: round2(row.cells.rechnung.value ?? 0), tx1: `Rechnung/Debitoren ${date}`,
        }));
      }

      // 4) Unklassifizierte Zahlarten (z. B. KD Tisch 5000 → 1104) — je Art
      // eine eigene Zeile; Konto ist durch die Validierung garantiert.
      for (const z of unclassified) {
        out.push(makeRow({
          kategorie: 'weitere_zahlungsarten',
          blg: nextBlg(), datum: date,
          kto: settings.kontoJeZahlungsart[z.key].trim(), gkto: k.umsatzTransit,
          netto: round2(z.amount), tx1: `${z.label} ${date}`,
        }));
      }

      // 5) Gutscheine: eingelöst (Zahlungsmittel) und verkauft (separat) —
      // jeweils Effektivwert (inkl. Korrektur über den Gutschein-Dialog).
      if ((row.cells.gutscheinEingeloest.value ?? 0) !== 0) {
        out.push(makeRow({
          kategorie: 'gutschein_eingeloest',
          blg: nextBlg(), datum: date, kto: k.gutscheine, gkto: k.umsatzTransit,
          netto: round2(row.cells.gutscheinEingeloest.value ?? 0), tx1: `Gutscheine eingelöst ${date}`,
        }));
      }
    }

    if ((row.cells.gutscheinVerkauft.value ?? 0) !== 0) {
      out.push(makeRow({
        kategorie: 'gutschein_verkauft',
        blg: nextBlg(), datum: date, kto: k.kasse, gkto: k.gutscheine,
        netto: round2(row.cells.gutscheinVerkauft.value ?? 0), tx1: `Gutscheine verkauft ${date}`,
      }));
    }

    // 6) Einzahlung Bank wird bewusst NICHT gebucht: sie steuert nur den
    //    fortlaufenden Kassensaldo (Übersicht/Tagesdetail/KPI); die Bankbuchung
    //    kommt separat aus dem Bankbeleg/Bankimport — ein Export hier wäre
    //    eine Doppelbuchung.

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
