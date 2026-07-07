/**
 * Tagesabschluss-Monatsübersicht — REINE Logik (DOM-/Supabase-frei)
 * =============================================================================
 * Baut aus den Z-Bericht-Tagesimporten (auto), manuellen Eingaben und
 * Korrektur-Overrides die Monats-Tabelle der Tagesabschlüsse analog der
 * Excel-Datei "UMSATZ Oliv" (Sheet "Buchung").
 *
 * Persistenz-Modell: eigener Blob `tagesabschluss_v1` (localStorage primär +
 * Supabase-KV-Backup, siehe tagesabschluss-db.ts). Es wird NIE in den
 * Adyen-Blob `adyenAbstimmung_v1` geschrieben — dessen Tagesbestätigungen
 * (Barbestand gezählt/Tag bestätigt) werden hier nur GELESEN bzw. über die
 * bestehenden Adyen-Mutationen gesetzt (ein einziger Bestätigungs-Store).
 *
 * Override-Namespace: `date:field` (geschlossene Field-Union) — bewusst
 * getrennt vom Adyen-Namespace `date:source:methodKey`.
 */

import {
  type AdyenAbstimmungBlob,
  type AdyenOverride,
  type AdyenComment,
  type DayConfirmation,
  type GnDayPayment,
  type AdyenDiffStatus,
  adyenDiffStatus,
  buildDayComparison,
  normalizeGnPaymentName,
} from './adyen-abstimmung';

export const TAGESABSCHLUSS_KEY = 'tagesabschluss_v1';

// ── Felder der Tagesübersicht ────────────────────────────────────────────────

/** Auto-Felder: aus dem Z-Bericht übernommen, per Override korrigierbar. */
export const TAGESABSCHLUSS_AUTO_FIELDS = [
  'umsatz',
  'netto',
  'mwst',
  'bar',
  'karten',
  'twint',
  'rechnung',
  'gutscheinVerkauft',
  'gutscheinEingeloest',
  'trinkgeld',
] as const;

/** Manuelle Felder: nur vom Benutzer erfasst (kein Auto-Wert). */
export const TAGESABSCHLUSS_MANUAL_FIELDS = ['bestandKasse', 'einzahlungBank'] as const;

export type TagesabschlussAutoField = (typeof TAGESABSCHLUSS_AUTO_FIELDS)[number];
export type TagesabschlussManualField = (typeof TAGESABSCHLUSS_MANUAL_FIELDS)[number];
export type TagesabschlussField = TagesabschlussAutoField | TagesabschlussManualField;

export const TAGESABSCHLUSS_FIELD_LABEL: Record<TagesabschlussField, string> = {
  umsatz: 'Umsatz',
  netto: 'Netto',
  mwst: 'MWST',
  bar: 'Bargeld / Barumsatz',
  bestandKasse: 'Bestand Kasse',
  karten: 'Kreditkarten / Adyen / SIX',
  twint: 'TWINT',
  rechnung: 'Rechnung / Debitoren',
  gutscheinVerkauft: 'Verkaufte Gutscheine',
  gutscheinEingeloest: 'Eingelöste Gutscheine',
  trinkgeld: 'Trinkgeld',
  einzahlungBank: 'Einzahlung Bank',
};

/** Stabiler Override-/Kommentar-Schlüssel: `date:field`. */
export function makeTagesabschlussFieldKey(date: string, field: TagesabschlussField): string {
  return `${date}:${field}`;
}

// ── Blob-Datenmodell ─────────────────────────────────────────────────────────

/** Einzelne Barausgabe (im CSV-Export je eine eigene Zeile). */
export interface CashExpense {
  id: string;
  date: string; // yyyy-MM-dd
  amount: number; // CHF, positiv
  konto: string;
  gegenkonto?: string;
  text: string;
  mwstCode?: string;
  belegNr?: string;
  kommentar?: string;
  updatedAt: string; // ISO
}

/** Manuelle Tageswerte (kein Auto-Wert vorhanden). */
export interface TagesabschlussManualDay {
  bestandKasse?: number;
  einzahlungBank?: number;
  bemerkung?: string;
  /** Gutscheinnummern (verkauft) — nur im Tagesdetail sichtbar, NIE in der Übersicht. */
  gutscheinNummernVerkauft?: string[];
  /** Gutscheinnummern (eingelöst) — nur im Tagesdetail sichtbar, NIE in der Übersicht. */
  gutscheinNummernEingeloest?: string[];
  updatedAt: string; // ISO — für merge-on-save (jüngster gewinnt)
}

/**
 * Patch für manuelle Tageswerte: NUR vorhandene Keys werden angefasst;
 * `null` / leerer String / leeres Array löscht das jeweilige Feld.
 */
export interface TagesabschlussManualPatch {
  bestandKasse?: number | null;
  einzahlungBank?: number | null;
  bemerkung?: string | null;
  gutscheinNummernVerkauft?: string[] | null;
  gutscheinNummernEingeloest?: string[] | null;
}

/** Rollen-Konten für den Buchhaltungs-Export (Tabelle2). */
export interface TagesabschlussExportSettings {
  /** Konto je Rolle — leere Strings = nicht konfiguriert (Export blockiert). */
  konten: {
    kasse: string;          // z. B. 1000
    bank: string;           // z. B. 1020
    debitoren: string;      // z. B. 1100
    gutscheine: string;     // z. B. 2003
    kartenSammel: string;   // z. B. 1110
    umsatz: string;         // z. B. 3000
    umsatzTransit: string;  // z. B. 1098 (DLK Umsatz)
  };
  /** Konto je Zahlungsarten-Key (mastercard/visa/twint/…); leer → kartenSammel. */
  kontoJeZahlungsart: Record<string, string>;
  /** MWST-Code je Z-Bericht-Steuersatz-Label (z. B. "8.1%" → "U81"). */
  mwstCodes: Record<string, string>;
  /** Erste Belegnummer (fortlaufend); leer = Blg-Spalte bleibt leer. */
  blgStart?: string;
  /** Benutzer hat das Mapping geprüft — Pflicht vor dem ersten Export. */
  reviewed: boolean;
  updatedAt: string; // ISO
}

export interface TagesabschlussBlob {
  /** Manuelle Tageswerte, Key = yyyy-MM-dd. */
  days: Record<string, TagesabschlussManualDay>;
  /** Barausgaben je Tag, Key = yyyy-MM-dd. */
  expenses: Record<string, CashExpense[]>;
  /** Korrektur-Overrides, Key = `date:field`. */
  overrides: Record<string, AdyenOverride>;
  /** Kommentare, Key = `date:field`. */
  comments: Record<string, AdyenComment>;
  /** Export-Einstellungen (null = noch nie konfiguriert). */
  exportSettings: TagesabschlussExportSettings | null;
}

export function emptyTagesabschlussBlob(): TagesabschlussBlob {
  return { days: {}, expenses: {}, overrides: {}, comments: {}, exportSettings: null };
}

/** Defensive Normalisierung eines (evtl. beschädigten) geladenen Blobs. */
export function normalizeTagesabschlussBlob(raw: unknown): TagesabschlussBlob {
  const empty = emptyTagesabschlussBlob();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const o = raw as Partial<TagesabschlussBlob>;
  const isObj = (v: unknown): v is Record<string, never> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const expenses: TagesabschlussBlob['expenses'] = {};
  if (isObj(o.expenses)) {
    for (const [date, list] of Object.entries(o.expenses as Record<string, unknown>)) {
      if (Array.isArray(list)) expenses[date] = list.filter(e => !!e && typeof e === 'object') as CashExpense[];
    }
  }
  return {
    days:      isObj(o.days)      ? (o.days      as TagesabschlussBlob['days'])      : {},
    expenses,
    overrides: isObj(o.overrides) ? (o.overrides as TagesabschlussBlob['overrides']) : {},
    comments:  isObj(o.comments)  ? (o.comments  as TagesabschlussBlob['comments'])  : {},
    exportSettings:
      isObj(o.exportSettings) ? (o.exportSettings as unknown as TagesabschlussExportSettings) : null,
  };
}

// ── Z-Bericht-Tagesdaten (Input aus dem read-only Loader) ────────────────────

export interface GnTaxRow {
  rate: string;   // Label wie im Z-Bericht, z. B. "8.1%"
  net: number;
  tax: number;
  gross: number;
}

export interface GnAccountingLine {
  name: string;
  account: string | null;
  taxRate: string | null;
  grossAmount: number;
}

export interface GnPaymentAccount {
  name: string;
  account: string | null;
  grossAmount: number;
}

/** Aggregierte Z-Bericht-Daten EINES Tages (nur Tagesimporte). */
export interface GnDayClosing {
  date: string; // yyyy-MM-dd
  grossRevenue: number | null;
  netRevenue: number | null;
  /** Trinkgeld = totalGross − totalExclTip (nur wenn beide vorhanden, > 0). */
  tip: number | null;
  taxes: GnTaxRow[];
  payments: GnDayPayment[];
  accountingLines: GnAccountingLine[];
  paymentAccounts: GnPaymentAccount[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Aus den Z-Bericht-Zahlungsarten die Spaltenwerte eines Tages ableiten. */
export function deriveAutoValues(closing: GnDayClosing): Record<TagesabschlussAutoField, number | null> {
  let bar = 0;
  let karten = 0;
  let twint = 0;
  let rechnung = 0;
  let gutscheinEingeloest = 0;
  let trinkgeldPm = 0;
  let hasBar = false, hasKarten = false, hasTwint = false, hasRechnung = false,
      hasGutschein = false, hasTip = false;

  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    if (norm.key === 'twint') { twint += pm.amount; hasTwint = true; continue; }
    if (norm.isCard) { karten += pm.amount; hasKarten = true; continue; }
    if (norm.key === 'bar' || /^bar(geld|zahlung)?$/.test(norm.key)) { bar += pm.amount; hasBar = true; continue; }
    if (/rechnung|debitor|hotel|auf_haus|kredit_kunde/.test(norm.key)) { rechnung += pm.amount; hasRechnung = true; continue; }
    if (/gutschein|voucher/.test(norm.key)) { gutscheinEingeloest += pm.amount; hasGutschein = true; continue; }
    if (/trinkgeld|^tip/.test(norm.key)) { trinkgeldPm += pm.amount; hasTip = true; continue; }
    // Übrige Nicht-Karten-Zahlarten (z. B. Lunch-Check) zählen wir bewusst
    // NICHT stillschweigend irgendwo hinein — sie erscheinen im Export nicht
    // automatisch und bleiben Sache der manuellen Kontrolle.
  }

  // Verkaufte Gutscheine: aus den Buchungskonten-Zeilen des Z-Berichts.
  let gutscheinVerkauft = 0;
  let hasVerkauft = false;
  for (const line of closing.accountingLines) {
    if (/gutschein/i.test(line.name) && !/einge/i.test(line.name)) {
      gutscheinVerkauft += line.grossAmount;
      hasVerkauft = true;
    }
  }

  const mwst = closing.taxes.length > 0
    ? round2(closing.taxes.reduce((s, t) => s + t.tax, 0))
    : null;

  const tip = closing.tip !== null && closing.tip > 0
    ? closing.tip
    : (hasTip ? round2(trinkgeldPm) : null);

  return {
    umsatz: closing.grossRevenue,
    netto: closing.netRevenue,
    mwst,
    bar: hasBar ? round2(bar) : null,
    karten: hasKarten ? round2(karten) : null,
    twint: hasTwint ? round2(twint) : null,
    rechnung: hasRechnung ? round2(rechnung) : null,
    gutscheinVerkauft: hasVerkauft ? round2(gutscheinVerkauft) : null,
    gutscheinEingeloest: hasGutschein ? round2(gutscheinEingeloest) : null,
    trinkgeld: tip,
  };
}

// ── Zellen-/Zeilenmodell ─────────────────────────────────────────────────────

export type CellSource = 'auto' | 'manual' | 'corrected' | 'missing';

export interface DayCell {
  /** Automatisch aus dem Z-Bericht übernommener Wert (null = keiner). */
  auto: number | null;
  /** Effektiver Rechenwert (Override > manuell > auto). */
  value: number | null;
  source: CellSource;
  override?: AdyenOverride;
  comment?: string;
}

export type TagesabschlussStatus = 'fehlt' | 'offen' | 'bestaetigt';

export interface TagesabschlussRow {
  date: string; // yyyy-MM-dd
  hasZbericht: boolean;
  cells: Record<TagesabschlussField, DayCell>;
  /** Summe der einzelnen Barausgaben des Tages (Übersicht zeigt NUR das Total). */
  barausgabenTotal: number;
  expenseCount: number;
  bemerkung?: string;
  /** Gutscheinnummern (verkauft) — NUR fürs Tagesdetail, nie in der Übersicht rendern. */
  gutscheinNummernVerkauft?: string[];
  /** Gutscheinnummern (eingelöst) — NUR fürs Tagesdetail, nie in der Übersicht rendern. */
  gutscheinNummernEingeloest?: string[];
  /**
   * Rechnerischer Barumsatz = Umsatz − Karten − TWINT − Rechnung − eingelöste
   * Gutscheine (effektive Werte). Basis für Export und Kassen-Differenz.
   */
  barumsatz: number | null;
  /**
   * Kassen-Differenz = (Bestand heute − Bestand Vortag)
   *                  − (Barumsatz − Barausgaben − Einzahlung Bank).
   * Nur wenn beide Bestände erfasst sind, sonst null.
   */
  kassenDiff: number | null;
  kassenDiffStatus: AdyenDiffStatus | null;
  /** Adyen-Import für diesen Tag vorhanden? */
  hasAdyen: boolean;
  /**
   * Karten/TWINT-Total laut Adyen (effektiver Wert inkl. Overrides aus dem
   * Adyen-Abgleich — gleiche Zahlen wie in der Adyen-Abgleich-Section).
   * null = kein Adyen-Import bzw. kein Adyen-Blob übergeben.
   */
  adyenTotal: number | null;
  /** Karten/TWINT-Total laut Z-Bericht aus dem Adyen-Vergleich (effektiv). */
  adyenZTotal: number | null;
  /** Differenz Z-Bericht − Adyen (effektive Werte); null = nicht vergleichbar. */
  adyenDiff: number | null;
  adyenDiffStatus: AdyenDiffStatus | null;
  status: TagesabschlussStatus;
  confirmation?: DayConfirmation;
}

export interface TagesabschlussTotals {
  values: Record<TagesabschlussField, number>;
  barausgaben: number;
  barumsatz: number;
  /** Summe Karten/TWINT laut Adyen (nur Tage mit Adyen-Import). */
  adyenTotal: number;
  /** Summe der Tages-Differenzen Z-Bericht − Adyen (kann sich aufheben). */
  adyenDiff: number;
  daysWithZbericht: number;
  daysConfirmed: number;
  /** Tage mit Z-Bericht, aber noch ohne Bestätigung. */
  daysOpen: number;
  /** Tage mit nicht-grüner Adyen- ODER Kassen-Differenz. */
  daysWithDiff: number;
}

export interface TagesabschlussMonth {
  rows: TagesabschlussRow[];
  totals: TagesabschlussTotals;
}

/** Alle Kalendertage eines Monats als yyyy-MM-dd (aufsteigend). */
export function monthDates(year: number, month: number): string[] {
  const mm = String(month).padStart(2, '0');
  const last = new Date(year, month, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) out.push(`${year}-${mm}-${String(d).padStart(2, '0')}`);
  return out;
}

/** Summe der Barausgaben einer Liste. */
export function expensesTotal(list: readonly CashExpense[] | undefined): number {
  if (!list || list.length === 0) return 0;
  return round2(list.reduce((s, e) => s + (Number.isFinite(e.amount) ? e.amount : 0), 0));
}

function buildCell(
  date: string,
  field: TagesabschlussField,
  auto: number | null,
  manual: number | null,
  blob: TagesabschlussBlob,
): DayCell {
  const key = makeTagesabschlussFieldKey(date, field);
  const ov = blob.overrides[key];
  const comment = blob.comments[key]?.text;
  if (ov && ov.correctedByManualOverride) {
    return { auto, value: ov.correctedValue, source: 'corrected', override: ov, ...(comment ? { comment } : {}) };
  }
  if (manual !== null && manual !== undefined) {
    return { auto, value: manual, source: 'manual', ...(comment ? { comment } : {}) };
  }
  if (auto !== null && auto !== undefined) {
    return { auto, value: auto, source: 'auto', ...(comment ? { comment } : {}) };
  }
  return { auto: null, value: null, source: 'missing', ...(comment ? { comment } : {}) };
}

/**
 * Baut die Monats-Tabelle der Tagesabschlüsse.
 * `confirmations` stammen aus dem Adyen-Blob (EIN Bestätigungs-Store).
 * `adyenBlob` (optional, rückwärtskompatibel): liefert pro Tag den
 * Karten/TWINT-Vergleich Z-Bericht vs. Adyen (via `buildDayComparison` —
 * exakt dieselben effektiven Werte wie in der Adyen-Abgleich-Section,
 * inkl. dortiger Overrides). Ohne Blob bleiben die Adyen-Felder null.
 */
export function buildTagesabschlussRows(
  year: number,
  month: number,
  closings: Record<string, GnDayClosing>,
  blob: TagesabschlussBlob,
  confirmations: Record<string, DayConfirmation>,
  adyenBlob?: AdyenAbstimmungBlob | null,
): TagesabschlussMonth {
  const rows: TagesabschlussRow[] = [];
  let prevBestand: number | null = null;

  for (const date of monthDates(year, month)) {
    const closing = closings[date];
    const manual = blob.days[date];
    const auto: Record<TagesabschlussAutoField, number | null> = closing
      ? deriveAutoValues(closing)
      : {
          umsatz: null, netto: null, mwst: null, bar: null, karten: null, twint: null,
          rechnung: null, gutscheinVerkauft: null, gutscheinEingeloest: null, trinkgeld: null,
        };

    const cells = {} as Record<TagesabschlussField, DayCell>;
    for (const f of TAGESABSCHLUSS_AUTO_FIELDS) {
      cells[f] = buildCell(date, f, auto[f], null, blob);
    }
    cells.bestandKasse = buildCell(date, 'bestandKasse', null, manual?.bestandKasse ?? null, blob);
    cells.einzahlungBank = buildCell(date, 'einzahlungBank', null, manual?.einzahlungBank ?? null, blob);

    const expenses = blob.expenses[date] ?? [];
    const barausgabenTotal = expensesTotal(expenses);

    const umsatz = cells.umsatz.value;
    const barumsatz = umsatz !== null
      ? round2(
          umsatz
          - (cells.karten.value ?? 0)
          - (cells.twint.value ?? 0)
          - (cells.rechnung.value ?? 0)
          - (cells.gutscheinEingeloest.value ?? 0),
        )
      : null;

    const bestand = cells.bestandKasse.value;
    let kassenDiff: number | null = null;
    if (bestand !== null && prevBestand !== null && barumsatz !== null) {
      const erwarteteBewegung = barumsatz - barausgabenTotal - (cells.einzahlungBank.value ?? 0);
      kassenDiff = round2(bestand - prevBestand - erwarteteBewegung);
    }

    const confirmation = confirmations[date];
    const status: TagesabschlussStatus = !closing
      ? 'fehlt'
      : confirmation?.confirmed
        ? 'bestaetigt'
        : 'offen';

    // Adyen-Vergleich (nur ANZEIGE): identische Rechenbasis wie die
    // Adyen-Abgleich-Section — buildDayComparison mit dem Adyen-Blob.
    const adyenDay = adyenBlob?.days[date] ?? null;
    let adyenTotal: number | null = null;
    let adyenZTotal: number | null = null;
    let adyenDiff: number | null = null;
    let adyenDiffSt: AdyenDiffStatus | null = null;
    if (adyenBlob && (closing || adyenDay)) {
      const cmp = buildDayComparison(date, closing ? closing.payments : null, adyenDay, adyenBlob);
      adyenTotal = cmp.cardTotalAdyen?.value ?? null;
      adyenZTotal = cmp.cardTotalZ?.value ?? null;
      adyenDiff = cmp.totalDiff;
      adyenDiffSt = cmp.totalStatus;
    }

    rows.push({
      date,
      hasZbericht: !!closing,
      cells,
      barausgabenTotal,
      expenseCount: expenses.length,
      ...(manual?.bemerkung ? { bemerkung: manual.bemerkung } : {}),
      ...(manual?.gutscheinNummernVerkauft?.length
        ? { gutscheinNummernVerkauft: manual.gutscheinNummernVerkauft } : {}),
      ...(manual?.gutscheinNummernEingeloest?.length
        ? { gutscheinNummernEingeloest: manual.gutscheinNummernEingeloest } : {}),
      barumsatz,
      kassenDiff,
      kassenDiffStatus: kassenDiff !== null ? adyenDiffStatus(kassenDiff) : null,
      hasAdyen: !!adyenDay,
      adyenTotal,
      adyenZTotal,
      adyenDiff,
      adyenDiffStatus: adyenDiffSt,
      status,
      ...(confirmation ? { confirmation } : {}),
    });

    if (bestand !== null) prevBestand = bestand;
  }

  const totals: TagesabschlussTotals = {
    values: Object.fromEntries(
      ([...TAGESABSCHLUSS_AUTO_FIELDS, ...TAGESABSCHLUSS_MANUAL_FIELDS] as TagesabschlussField[])
        .map(f => [
          f,
          round2(rows.reduce((s, r) => s + (r.cells[f].value ?? 0), 0)),
        ]),
    ) as Record<TagesabschlussField, number>,
    barausgaben: round2(rows.reduce((s, r) => s + r.barausgabenTotal, 0)),
    barumsatz: round2(rows.reduce((s, r) => s + (r.barumsatz ?? 0), 0)),
    adyenTotal: round2(rows.reduce((s, r) => s + (r.adyenTotal ?? 0), 0)),
    adyenDiff: round2(rows.reduce((s, r) => s + (r.adyenDiff ?? 0), 0)),
    daysWithZbericht: rows.filter(r => r.hasZbericht).length,
    daysConfirmed: rows.filter(r => r.status === 'bestaetigt').length,
    daysOpen: rows.filter(r => r.status === 'offen').length,
    daysWithDiff: rows.filter(r =>
      (r.adyenDiffStatus !== null && r.adyenDiffStatus !== 'ok')
      || (r.kassenDiffStatus !== null && r.kassenDiffStatus !== 'ok'),
    ).length,
  };
  // Bestand Kasse ist ein STAND, keine Summe — Total wäre irreführend.
  totals.values.bestandKasse = rows.reduce((last, r) => r.cells.bestandKasse.value ?? last, 0);

  return { rows, totals };
}

// ── Mutationen (rein, immutabel) ─────────────────────────────────────────────

/**
 * Setzt/entfernt manuelle Tageswerte. NUR im Patch vorhandene Keys werden
 * angefasst — `null`/`undefined`/leerer String löscht das jeweilige Feld.
 * Inline-Edits dürfen daher ein einzelnes Feld patchen, ohne die übrigen
 * manuellen Werte des Tages zu verlieren.
 */
export function upsertManualDay(
  blob: TagesabschlussBlob,
  date: string,
  patch: TagesabschlussManualPatch,
  now: string,
): TagesabschlussBlob {
  const existing = blob.days[date];
  const next: TagesabschlussManualDay = { ...existing, updatedAt: now };
  for (const [k, v] of Object.entries(patch) as Array<[keyof TagesabschlussManualPatch, unknown]>) {
    if (Array.isArray(v)) {
      // Gutscheinnummern: trimmen, Leereinträge verwerfen; leer → Feld löschen.
      const cleaned = v.map(s => String(s).trim()).filter(s => s !== '');
      if (cleaned.length === 0) delete (next as Record<string, unknown>)[k];
      else (next as Record<string, unknown>)[k] = cleaned;
      continue;
    }
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      delete (next as Record<string, unknown>)[k];
    } else {
      (next as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  const days = { ...blob.days };
  const hasContent =
    next.bestandKasse !== undefined || next.einzahlungBank !== undefined || next.bemerkung !== undefined
    || next.gutscheinNummernVerkauft !== undefined || next.gutscheinNummernEingeloest !== undefined;
  if (hasContent) days[date] = next;
  else delete days[date];
  return { ...blob, days };
}

/** Setzt oder entfernt einen Korrektur-Override. correctedValue===null entfernt. */
export function setTagesabschlussOverride(
  blob: TagesabschlussBlob,
  date: string,
  field: TagesabschlussField,
  originalValue: number,
  correctedValue: number | null,
  comment: string | undefined,
  now: string,
): TagesabschlussBlob {
  const key = makeTagesabschlussFieldKey(date, field);
  const overrides = { ...blob.overrides };
  if (correctedValue === null) {
    delete overrides[key];
  } else {
    const existing = overrides[key];
    overrides[key] = {
      // Original des ERSTEN Overrides behalten — nie den korrigierten Wert
      // als neues "Original" verankern (gleiches Prinzip wie Adyen-Abgleich).
      originalValue: existing ? existing.originalValue : originalValue,
      correctedValue,
      correctedByManualOverride: true,
      ...(comment !== undefined && comment.trim() !== '' ? { comment: comment.trim() } : {}),
      updatedAt: now,
    };
  }
  return { ...blob, overrides };
}

/** Setzt oder entfernt einen Kommentar (leerer Text entfernt). */
export function setTagesabschlussComment(
  blob: TagesabschlussBlob,
  date: string,
  field: TagesabschlussField,
  text: string,
  now: string,
): TagesabschlussBlob {
  const key = makeTagesabschlussFieldKey(date, field);
  const comments = { ...blob.comments };
  const trimmed = text.trim();
  if (trimmed === '') delete comments[key];
  else comments[key] = { text: trimmed, updatedAt: now };
  return { ...blob, comments };
}

/** Fügt eine Barausgabe hinzu oder aktualisiert sie (Match über id). */
export function upsertExpense(blob: TagesabschlussBlob, expense: CashExpense): TagesabschlussBlob {
  const expenses = { ...blob.expenses };
  // Bei Datumswechsel einer bestehenden Ausgabe: aus alter Liste entfernen.
  for (const [date, list] of Object.entries(expenses)) {
    if (date !== expense.date && list.some(e => e.id === expense.id)) {
      const filtered = list.filter(e => e.id !== expense.id);
      if (filtered.length > 0) expenses[date] = filtered;
      else delete expenses[date];
    }
  }
  const list = expenses[expense.date] ?? [];
  const idx = list.findIndex(e => e.id === expense.id);
  const nextList = idx >= 0 ? list.map(e => (e.id === expense.id ? expense : e)) : [...list, expense];
  expenses[expense.date] = nextList;
  return { ...blob, expenses };
}

/** Entfernt eine Barausgabe. */
export function removeExpense(blob: TagesabschlussBlob, date: string, id: string): TagesabschlussBlob {
  const list = blob.expenses[date];
  if (!list) return blob;
  const filtered = list.filter(e => e.id !== id);
  const expenses = { ...blob.expenses };
  if (filtered.length > 0) expenses[date] = filtered;
  else delete expenses[date];
  return { ...blob, expenses };
}

// ── Export-Einstellungen ─────────────────────────────────────────────────────

/**
 * Default-VORSCHLAG auf Basis des vom Benutzer gelieferten Kontenplans
 * "Kontoplan Oliv" (echte Konten, keine Erfindung). MUSS vor dem ersten
 * Export geprüft werden (`reviewed`-Pflicht in der Export-Validierung).
 */
export function defaultExportSettings(now: string): TagesabschlussExportSettings {
  return {
    konten: {
      kasse: '1000',          // Kasse
      bank: '1020',           // UBS Konto
      debitoren: '1100',      // Forderungen (Debitoren)
      gutscheine: '2003',     // Abrechnungs Kto. Gutscheine
      kartenSammel: '1110',   // Kreditkarten (DLK)
      umsatz: '3000',         // Ertrag A
      umsatzTransit: '1098',  // DLK Umsatz
    },
    kontoJeZahlungsart: {
      maestro: '1111',        // KK MAESTRO
      visa: '1112',           // KK VISA
      amex: '1114',           // KK AMEX
      twint: '1119',          // KK TWINT
    },
    mwstCodes: {},
    reviewed: false,
    updatedAt: now,
  };
}

/** Aktualisiert die Export-Einstellungen im Blob. */
export function setExportSettings(
  blob: TagesabschlussBlob,
  settings: TagesabschlussExportSettings,
): TagesabschlussBlob {
  return { ...blob, exportSettings: settings };
}

// ── Merge zweier Blob-Stände (für merge-on-save, Finanzdaten!) ───────────────

const newer = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '') >= (b ?? '');

/**
 * Merged den lokalen (zu speichernden) Stand mit einem evtl. neueren
 * Remote-Stand aus dem KV-Backup — je Schlüssel gewinnt der jüngere
 * `updatedAt`. So überschreibt ein Gerät mit veraltetem localStorage nie
 * stillschweigend die Eingaben eines anderen Geräts (kein naiver Blob-Write,
 * gleiches Prinzip wie safeUpsertDailyBudgets).
 */
export function mergeTagesabschlussBlobs(
  local: TagesabschlussBlob,
  remote: TagesabschlussBlob,
): TagesabschlussBlob {
  const days: TagesabschlussBlob['days'] = { ...remote.days };
  for (const [date, day] of Object.entries(local.days)) {
    const r = days[date];
    if (!r || newer(day.updatedAt, r.updatedAt)) days[date] = day;
  }

  const overrides: TagesabschlussBlob['overrides'] = { ...remote.overrides };
  for (const [key, ov] of Object.entries(local.overrides)) {
    const r = overrides[key];
    if (!r || newer(ov.updatedAt, r.updatedAt)) overrides[key] = ov;
  }

  const comments: TagesabschlussBlob['comments'] = { ...remote.comments };
  for (const [key, c] of Object.entries(local.comments)) {
    const r = comments[key];
    if (!r || newer(c.updatedAt, r.updatedAt)) comments[key] = c;
  }

  // Barausgaben: je Ausgabe (id) der jüngere Stand; Vereinigung beider Seiten.
  const byId = new Map<string, CashExpense>();
  for (const list of Object.values(remote.expenses)) {
    for (const e of list) byId.set(e.id, e);
  }
  for (const list of Object.values(local.expenses)) {
    for (const e of list) {
      const r = byId.get(e.id);
      if (!r || newer(e.updatedAt, r.updatedAt)) byId.set(e.id, e);
    }
  }
  const expenses: TagesabschlussBlob['expenses'] = {};
  for (const e of byId.values()) {
    (expenses[e.date] ??= []).push(e);
  }
  for (const list of Object.values(expenses)) {
    list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  const exportSettings =
    local.exportSettings && remote.exportSettings
      ? (newer(local.exportSettings.updatedAt, remote.exportSettings.updatedAt)
          ? local.exportSettings
          : remote.exportSettings)
      : local.exportSettings ?? remote.exportSettings;

  return { days, expenses, overrides, comments, exportSettings };
}
